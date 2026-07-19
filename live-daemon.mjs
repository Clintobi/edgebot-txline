// EdgeBot persistent repricing daemon.
// Every unique TxLINE 1X2 SSE tick is priced immediately against the current
// market, passed through one fail-closed policy seam, and written to an
// append-only hash-chained decision ledger before the next tick is handled.
//
// Credential-free judge replay:
//   npm run daemon:replay
// Live paper mode:
//   FIXTURE=... CREDS=txline-creds.json npm run daemon
// Opt-in on-chain mode:
//   FIXTURE=... CREDS=... EDGEBOT_KEYPAIR=... MINT=... EXECUTION=onchain npm run daemon

import { createHash } from 'crypto'
import fs from 'fs'
import { dirname } from 'path'
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, ComputeBudgetProgram,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { GateLedger, DEFAULT_POLICY, decideTrade } from './lib/policy-gate.mjs'
import { oddsTicks, proposeTrade, scoreEvents, tickFingerprint } from './lib/repricer.mjs'
import { parseSseBlock, parseSseData, reconnectingSse } from './lib/sse.mjs'

const API = process.env.TXLINE_API || 'https://txline-dev.txodds.com'
const RPC = process.env.RPC || 'https://api.devnet.solana.com'
const PROGRAM = new PublicKey(process.env.PROGRAM || 'AfvTruVTsrMfqSe5Tgss6hEgYNkk9ADAGKupSQr2DbD8')
const TXLINE_PROGRAM = new PublicKey(process.env.TXLINE_PROGRAM || '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J')
const args = process.argv.slice(2)
const replayFlag = args.indexOf('--replay')
const replayPath = replayFlag >= 0 ? (args[replayFlag + 1] || 'test/fixtures/odds-replay.sse') : null
const FIXTURE = Number(process.env.FIXTURE || 18257865)
const EXECUTION = replayPath ? 'paper' : (process.env.EXECUTION || 'paper')
const LEDGER_PATH = process.env.GATE_LEDGER || (replayPath ? `/tmp/edgebot-replay-gate-ledger-${process.pid}.jsonl` : 'data/gate-ledger.jsonl')
const MAX_TICKS = Number(process.env.MAX_TICKS || (replayPath ? Infinity : Infinity))
const SCALE = 1_000000
const CAPTURE_PATH = process.env.CAPTURE_SSE || null
const RECEIPT_PATH = process.env.RECEIPT_OUT || null

const disc = name => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
const i64 = n => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b }
const i32 = n => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b }
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const cat = (...parts) => Buffer.concat(parts)
const vec = (items, encode) => cat(u32(items.length), ...items.map(encode))
const proofNode = node => cat(Buffer.from(node.hash), Buffer.from([node.isRightSibling ? 1 : 0]))
const statSummary = stat => cat(u32(stat.key), i32(stat.value), i32(stat.period))
const statProof = (stat, root, proof) => cat(statSummary(stat), Buffer.from(root), vec(proof, proofNode))
function encodeSettleProof(proof) {
  const summary = cat(
    i64(proof.summary.fixtureId), i32(proof.summary.updateStats.updateCount),
    i64(proof.summary.updateStats.minTimestamp), i64(proof.summary.updateStats.maxTimestamp),
    Buffer.from(proof.summary.eventStatsSubTreeRoot),
  )
  return cat(
    i64(proof.summary.updateStats.minTimestamp), summary,
    vec(proof.subTreeProof, proofNode), vec(proof.mainTreeProof, proofNode),
    i32(0), Buffer.from([0]),
    statProof(proof.statsToProve[0], proof.eventStatRoot, proof.statProofs[0]),
    Buffer.from([1]), statProof(proof.statsToProve[1], proof.eventStatRoot, proof.statProofs[1]),
    Buffer.from([1, 1]),
  )
}
const [marketPda] = PublicKey.findProgramAddressSync([Buffer.from('market'), u64(FIXTURE)], PROGRAM)
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from('vault'), marketPda.toBuffer()], PROGRAM)
const depositPda = user => PublicKey.findProgramAddressSync([Buffer.from('deposit'), marketPda.toBuffer(), user.toBuffer()], PROGRAM)[0]

function exposureFromLedger(path) {
  if (!fs.existsSync(path)) return 0
  return fs.readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).reduce((total, line) => {
    try { const row = JSON.parse(line); return total + (row.executed ? Number(row.intent?.amount || 0) : 0) } catch { return total }
  }, 0)
}

function backedSidesFromLedger(path) {
  if (!fs.existsSync(path)) return new Set()
  return new Set(fs.readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).flatMap(line => {
    try { const row = JSON.parse(line); return row.executed && row.intent?.side ? [row.intent.side] : [] } catch { return [] }
  }))
}

function seenTicksFromLedger(path) {
  if (!fs.existsSync(path)) return new Set()
  return new Set(fs.readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).flatMap(line => {
    try {
      const row = JSON.parse(line)
      if (!row.intent?.tickId) return []
      return [row.intent.streamEventId ? `${row.intent.streamEventId}:${row.intent.tickId}` : row.intent.tickId]
    } catch { return [] }
  }))
}

function appendJsonl(path, value) {
  if (!path) return
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

function capture(stream, message) {
  appendJsonl(CAPTURE_PATH, {
    capturedAt: new Date().toISOString(), stream, id: message.id || null,
    event: message.event || null, data: message.data,
  })
}

function paperVenue() {
  let market = {
    yes: Number(process.env.PAPER_YES || 100 * SCALE),
    no: Number(process.env.PAPER_NO || 100 * SCALE),
  }
  return {
    bankroll: Number(process.env.BANKROLL || 1000 * SCALE),
    marketState: async () => ({ ...market }),
    execute: async intent => {
      if (intent.side === 'YES') market.yes += intent.amount
      else market.no += intent.amount
      return `paper:${intent.tickId.slice(0, 12)}`
    },
    settleAndClaim: async proof => ({
      mode: 'paper',
      resolution: Number(proof.statsToProve[0].value) > Number(proof.statsToProve[1].value) ? 'YES' : 'NO',
      settleSignature: null,
      claimSignature: null,
    }),
  }
}

async function onchainVenue() {
  if (!process.env.EDGEBOT_KEYPAIR) throw new Error('EDGEBOT_KEYPAIR is required only for EXECUTION=onchain')
  if (!process.env.MINT) throw new Error('MINT is required only for EXECUTION=onchain')
  const secret = JSON.parse(fs.readFileSync(process.env.EDGEBOT_KEYPAIR, 'utf8'))
  const trader = Keypair.fromSecretKey(Uint8Array.from(secret))
  const mint = new PublicKey(process.env.MINT)
  const conn = new Connection(RPC, 'confirmed')
  const userToken = getAssociatedTokenAddressSync(mint, trader.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
  const vault = getAssociatedTokenAddressSync(mint, vaultAuth, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
  const balance = Number((await getAccount(conn, userToken, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount)
  if (!await conn.getAccountInfo(marketPda)) throw new Error(`market ${marketPda} does not exist`)
  return {
    bankroll: Number(process.env.BANKROLL || balance),
    marketState: async () => {
      const info = await conn.getAccountInfo(marketPda)
      if (!info) throw new Error('market disappeared')
      const settled = info.data[85] === 1
      const resolution = info.data[102] === 1 ? (info.data[103] === 0 ? 'YES' : 'NO') : null
      return { yes: Number(info.data.readBigUInt64LE(86)), no: Number(info.data.readBigUInt64LE(94)), settled, resolution }
    },
    execute: async intent => {
      const ix = new TransactionInstruction({
        programId: PROGRAM,
        data: cat(disc(intent.side === 'YES' ? 'deposit_yes' : 'deposit_no'), u64(intent.amount)),
        keys: [
          { pubkey: marketPda, isSigner: false, isWritable: true },
          { pubkey: trader.publicKey, isSigner: true, isWritable: true },
          { pubkey: depositPda(trader.publicKey), isSigner: false, isWritable: true },
          { pubkey: userToken, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: vaultAuth, isSigner: false, isWritable: false },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      })
      return sendAndConfirmTransaction(conn, new Transaction().add(ix), [trader], { commitment: 'confirmed' })
    },
    settleAndClaim: async (proof, backedSides) => {
      let market = await (async () => {
        const info = await conn.getAccountInfo(marketPda)
        return {
          yes: Number(info.data.readBigUInt64LE(86)), no: Number(info.data.readBigUInt64LE(94)),
          settled: info.data[85] === 1,
          resolution: info.data[102] === 1 ? (info.data[103] === 0 ? 'YES' : 'NO') : null,
        }
      })()
      let settleSignature = null
      if (!market.settled) {
        const day = Math.floor(proof.summary.updateStats.minTimestamp / 86_400_000)
        const dayBytes = Buffer.alloc(2); dayBytes.writeUInt16LE(day & 0xffff)
        const roots = PublicKey.findProgramAddressSync([Buffer.from('daily_scores_roots'), dayBytes], TXLINE_PROGRAM)[0]
        const settleIx = new TransactionInstruction({
          programId: PROGRAM,
          data: cat(disc('settle'), encodeSettleProof(proof)),
          keys: [
            { pubkey: marketPda, isSigner: false, isWritable: true },
            { pubkey: trader.publicKey, isSigner: true, isWritable: false },
            { pubkey: TXLINE_PROGRAM, isSigner: false, isWritable: false },
            { pubkey: roots, isSigner: false, isWritable: false },
          ],
        })
        settleSignature = await sendAndConfirmTransaction(
          conn,
          new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), settleIx),
          [trader],
          { commitment: 'confirmed' },
        )
        market = await (async () => {
          const info = await conn.getAccountInfo(marketPda)
          return {
            yes: Number(info.data.readBigUInt64LE(86)), no: Number(info.data.readBigUInt64LE(94)),
            settled: info.data[85] === 1,
            resolution: info.data[102] === 1 ? (info.data[103] === 0 ? 'YES' : 'NO') : null,
          }
        })()
      }
      let claimSignature = null
      let claimError = null
      if (market.resolution && backedSides.has(market.resolution)) {
        const amount = market.resolution === 'YES' ? market.yes : market.no
        const claimIx = new TransactionInstruction({
          programId: PROGRAM,
          data: cat(disc('claim_winnings'), u64(amount)),
          keys: [
            { pubkey: marketPda, isSigner: false, isWritable: true },
            { pubkey: trader.publicKey, isSigner: true, isWritable: true },
            { pubkey: depositPda(trader.publicKey), isSigner: false, isWritable: true },
            { pubkey: userToken, isSigner: false, isWritable: true },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: vaultAuth, isSigner: false, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
        })
        try {
          claimSignature = await sendAndConfirmTransaction(conn, new Transaction().add(claimIx), [trader], { commitment: 'confirmed' })
        } catch (error) { claimError = error.message }
      }
      return { mode: 'onchain', resolution: market.resolution, settleSignature, claimSignature, claimError }
    },
    market: marketPda.toBase58(),
    trader: trader.publicKey.toBase58(),
    mint: mint.toBase58(),
  }
}

async function* replayMessages(path) {
  const text = fs.readFileSync(path, 'utf8')
  for (const block of text.split(/\r?\n\r?\n/)) {
    const message = parseSseBlock(block)
    if (message) yield message
  }
}

async function authHeaders() {
  if (!process.env.CREDS) throw new Error('CREDS is required for live TxLINE SSE (use npm run daemon:replay for zero-credential proof)')
  const creds = JSON.parse(fs.readFileSync(process.env.CREDS, 'utf8'))
  const apiToken = typeof creds.apiToken === 'string' ? creds.apiToken : creds.apiToken?.token
  if (!apiToken) throw new Error('CREDS contains no apiToken')
  const response = await fetch(`${API}/auth/guest/start`, { method: 'POST' })
  if (!response.ok) throw new Error(`guest auth failed: ${response.status}`)
  const jwt = (await response.json()).token
  return { Authorization: `Bearer ${jwt}`, 'X-Api-Token': apiToken }
}

async function txJson(path) {
  const response = await fetch(`${API}/api${path}`, { headers: await authHeaders() })
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`)
  return response.json()
}

async function finalProof() {
  const rows = await txJson(`/scores/snapshot/${FIXTURE}`)
  const sequences = [...new Set((Array.isArray(rows) ? rows : []).map(row => row.Seq).filter(x => x != null))].sort((a, b) => b - a)
  for (const sequence of sequences.slice(0, 20)) {
    try {
      const proof = await txJson(`/scores/stat-validation?fixtureId=${FIXTURE}&seq=${sequence}&statKeys=1,2`)
      if (proof?.statsToProve?.length === 2 && proof.statsToProve.every(stat => stat.period === 100)) return proof
    } catch { /* the fixture is not yet final at this sequence */ }
  }
  return null
}

const venue = EXECUTION === 'onchain' ? await onchainVenue() : paperVenue()
const state = {
  bankroll: venue.bankroll,
  exposure: exposureFromLedger(LEDGER_PATH),
  allowedFixtureIds: new Set([FIXTURE]),
  halted: null,
}
const policy = {
  ...DEFAULT_POLICY,
  minEdge: Number(process.env.MIN_EDGE || DEFAULT_POLICY.minEdge),
  maxPlausibleEdge: Number(process.env.MAX_PLAUSIBLE_EDGE || DEFAULT_POLICY.maxPlausibleEdge),
  maxSignalAgeMs: Number(process.env.MAX_SIGNAL_AGE_MS || DEFAULT_POLICY.maxSignalAgeMs),
  maxOrderFraction: Number(process.env.MAX_POSITION || DEFAULT_POLICY.maxOrderFraction),
  maxExposureFraction: Number(process.env.MAX_EXPOSURE || DEFAULT_POLICY.maxExposureFraction),
}
const ledger = new GateLedger(LEDGER_PATH)
const seen = seenTicksFromLedger(LEDGER_PATH)
let priced = 0
let allowed = 0
let denied = 0

console.log(`\nEdgeBot per-tick daemon · fixture ${FIXTURE} · ${replayPath ? 'credential-free replay' : 'TxLINE SSE'} · ${EXECUTION} execution`)
console.log(`market ${marketPda.toBase58()} · gate ledger ${LEDGER_PATH}`)
console.log(`policy ${(policy.minEdge * 100).toFixed(1)}% min edge · ${(policy.maxOrderFraction * 100).toFixed(0)}%/order · ${(policy.maxExposureFraction * 100).toFixed(0)}% exposure\n`)

const controller = new AbortController()
if (!replayPath) {
  process.once('SIGINT', () => controller.abort(new Error('SIGINT')))
  process.once('SIGTERM', () => controller.abort(new Error('SIGTERM')))
}

const streamStatus = stream => status => console.log(`[${stream}] ${status.state}${status.retryMs ? ` in ${status.retryMs}ms` : ''}${status.error ? ` — ${status.error}` : ''}`)

async function processOdds() {
  const messages = replayPath
    ? replayMessages(replayPath)
    : reconnectingSse({ url: `${API}/api/odds/stream`, headers: authHeaders, signal: controller.signal, onStatus: streamStatus('odds') })
  for await (const message of messages) {
    capture('odds', message)
    const payload = parseSseData(message.data)
    for (const tick of oddsTicks(payload, FIXTURE)) {
      const fingerprint = message.id ? `${message.id}:${tickFingerprint(tick)}` : tickFingerprint(tick)
      if (seen.has(fingerprint)) continue
      seen.add(fingerprint)
      priced += 1
      const market = await venue.marketState()
      if (market.settled) state.halted = `market settled ${market.resolution || ''}`.trim()
      const intent = {
        ...proposeTrade(tick, market, state, {
          now: replayPath ? tick.signalAt + 100 : Date.now(),
          maxOrderFraction: policy.maxOrderFraction,
          maxExposureFraction: policy.maxExposureFraction,
        }),
        streamEventId: message.id || null,
      }
      const result = decideTrade(intent, state, policy)
      let executionId = null
      let executionError = null
      let executed = false
      if (result.decision === 'ALLOW') {
        try {
          executionId = await venue.execute(intent)
          executed = true
          state.exposure += intent.amount
          allowed += 1
        } catch (error) {
          executionError = error.message
          state.halted = `executor failure: ${error.message}`
        }
      } else denied += 1
      const entry = ledger.record({ intent, result, executed, executionId, executionError })
      if (executed && EXECUTION === 'onchain') {
        appendJsonl(RECEIPT_PATH, {
          version: 1,
          kind: 'tick-to-transaction',
          fixtureId: FIXTURE,
          capturedAt: new Date().toISOString(),
          streamEventId: intent.streamEventId,
          tickId: intent.tickId,
          policyDecision: result.decision,
          policyLedgerHash: entry.hash,
          transactionSignature: executionId,
          market: venue.market,
          trader: venue.trader,
          mint: venue.mint,
        })
      }
      console.log(`[tick ${priced}] fair ${(intent.fair * 100).toFixed(1)}% · market YES ${(intent.marketYes * 100).toFixed(1)}% · ${intent.side} edge ${(intent.edge * 100).toFixed(1)}% · ${result.decision}${executed ? ` ${intent.amount / SCALE} USDC` : ''}${executionError ? ` (${executionError})` : ''}`)
      if (priced >= MAX_TICKS) { controller.abort(new Error('MAX_TICKS reached')); break }
    }
    if (priced >= MAX_TICKS) break
  }
}

let settlementStarted = false
async function tryFinalise(trigger) {
  if (settlementStarted) return
  const proof = await finalProof()
  if (!proof) return
  settlementStarted = true
  const g1 = Number(proof.statsToProve[0].value)
  const g2 = Number(proof.statsToProve[1].value)
  console.log(`[settlement] full-time proof found from ${trigger}: ${g1}-${g2}; settling permissionlessly...`)
  try {
    const result = await venue.settleAndClaim(proof, backedSidesFromLedger(LEDGER_PATH))
    state.halted = `market settled ${result.resolution}`
    appendJsonl(RECEIPT_PATH, {
      version: 1,
      kind: 'proof-settle-claim',
      fixtureId: FIXTURE,
      recordedAt: new Date().toISOString(),
      fullTimeScore: { participant1: g1, participant2: g2 },
      derivedResolution: g1 > g2 ? 'YES' : 'NO',
      onchainResolution: result.resolution,
      settleSignature: result.settleSignature,
      claimSignature: result.claimSignature,
      claimError: result.claimError || null,
      policyLedgerHead: ledger.previousHash,
      market: venue.market || marketPda.toBase58(),
    })
    console.log(`[settlement] resolved ${result.resolution}${result.settleSignature ? ` · settle tx ${result.settleSignature}` : ''}${result.claimSignature ? ` · claim tx ${result.claimSignature}` : ''}`)
    controller.abort(new Error('lifecycle complete'))
  } catch (error) {
    state.halted = `settlement failure: ${error.message}`
    console.error(`[settlement] HALTED — ${error.message}`)
  }
}

async function processScores() {
  await tryFinalise('startup snapshot')
  if (settlementStarted || controller.signal.aborted) return
  const messages = reconnectingSse({ url: `${API}/api/scores/stream`, headers: authHeaders, signal: controller.signal, onStatus: streamStatus('scores') })
  for await (const message of messages) {
    capture('scores', message)
    if (scoreEvents(parseSseData(message.data), FIXTURE).length > 0) await tryFinalise(`score event ${message.id || '(no id)'}`)
    if (settlementStarted || controller.signal.aborted) break
  }
}

if (replayPath) await processOdds()
else await Promise.all([processOdds(), processScores()])

console.log(`\nrepriced ${priced} unique odds ticks · ${allowed} allowed/executed · ${denied} denied · exposure ${(state.exposure / state.bankroll * 100).toFixed(1)}%`)
console.log(`Every trade decision is audit-linked in ${LEDGER_PATH}.\n`)

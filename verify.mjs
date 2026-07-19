// verify.mjs — credential-free judge verifier for EdgeBot.
//
// Re-checks the last autonomous run end-to-end with NO keys and NO wallet:
//   1. reads the on-chain market from PUBLIC devnet RPC (state + resolution),
//   2. finds the immutable settlement transaction, decodes the TxLINE proof values
//      embedded in it, and confirms the canonical TxLINE CPI executed successfully,
//   3. confirms the on-chain pools match the reported run, and
//   4. re-runs the CLV backtest from the committed cache and checks it reproduces.
// Everything is public and read-only, so anyone can run:  npm run judge:verify
import fs from 'fs'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { Connection, PublicKey } from '@solana/web3.js'
import { verifyGateLedger } from './lib/policy-gate.mjs'
import { oddsTicks, tickFingerprint } from './lib/repricer.mjs'

const RPC = process.env.RPC || 'https://api.devnet.solana.com'
const PROGRAM = 'AfvTruVTsrMfqSe5Tgss6hEgYNkk9ADAGKupSQr2DbD8'
const TXLINE = '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J'
const run = JSON.parse(fs.readFileSync(process.env.RUN || new URL('./dashboard/last-run.json', import.meta.url), 'utf8'))
const discriminator = name => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)

function decodeSettlement(data) {
  let offset = 8
  const i64 = () => { const value = Number(data.readBigInt64LE(offset)); offset += 8; return value }
  const i32 = () => { const value = data.readInt32LE(offset); offset += 4; return value }
  const u32 = () => { const value = data.readUInt32LE(offset); offset += 4; return value }
  const skipProof = () => { const length = u32(); offset += length * 33 }
  const stat = () => {
    const value = { key: u32(), value: i32(), period: i32() }
    offset += 32
    skipProof()
    return value
  }

  i64() // top-level proof timestamp
  const fixtureId = i64()
  i32(); i64(); i64(); offset += 32 // update stats + event-stats root
  skipProof(); skipProof()
  i32(); offset += 1 // threshold + comparison
  const home = stat()
  if (data[offset++] !== 1) throw new Error('settlement has no second statistic')
  const away = stat()
  return { fixtureId, home, away }
}

function messageKeys(message) {
  return (message.staticAccountKeys || message.accountKeys || []).map(key => key.toBase58())
}

function instructionData(transaction, program, wantedDiscriminator) {
  const message = transaction?.transaction?.message
  if (!message) return null
  const keys = messageKeys(message)
  for (const instruction of message.compiledInstructions || message.instructions || []) {
    if (keys[instruction.programIdIndex] !== program) continue
    const data = Buffer.from(instruction.data)
    if (data.subarray(0, 8).equals(wantedDiscriminator)) return data
  }
  return null
}

let pass = 0, fail = 0
const ok = (label, good, detail) => { console.log(`  ${good ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`); good ? pass++ : fail++ }

console.log(`\nEdgeBot judge verifier — read-only, no credentials`)
console.log(`run: "${run.teams}" (TxLINE fixture ${run.fixture}) · market ${run.market}\n`)

// --- 1 & 3: on-chain market state, resolution, pools ---
const conn = new Connection(RPC, 'confirmed')
const info = await conn.getAccountInfo(new PublicKey(run.market))
if (!info) { ok('market exists on devnet', false, 'account not found'); }
else {
  const d = info.data
  const settled = d[85] === 1
  const onchainRes = d[102] === 1 ? (d[103] === 0 ? 'YES' : 'NO') : null
  const yes = Number(d.readBigUInt64LE(86)), no = Number(d.readBigUInt64LE(94))
  ok('market is Settled on-chain', settled)
  ok('on-chain pools match the run', yes === run.final.yes && no === run.final.no, `chain ${yes/1e6}/${no/1e6} vs run ${run.final.yes/1e6}/${run.final.no/1e6}`)

  // --- 2: recover the submitted TxLINE proof from the immutable settlement tx ---
  const signatures = await conn.getSignaturesForAddress(new PublicKey(run.market), { limit: 30 })
  const transactions = await conn.getTransactions(signatures.map(row => row.signature), {
    commitment: 'confirmed', maxSupportedTransactionVersion: 0,
  })
  const settleDisc = discriminator('settle')
  const settledTx = transactions.find(transaction => instructionData(transaction, PROGRAM, settleDisc))
  const settleData = settledTx && instructionData(settledTx, PROGRAM, settleDisc)
  if (!settledTx || !settleData) ok('proof-settlement transaction is public', false, 'not found in market history')
  else {
    const proof = decodeSettlement(settleData)
    const g1 = proof.home.value, g2 = proof.away.value
    const derived = g1 > g2 ? 'YES' : 'NO'
    const invokedTxline = settledTx.meta?.logMessages?.some(line => line.includes(`Program ${TXLINE} invoke`))
    ok('settlement contains the final TxLINE proof', proof.fixtureId === run.fixture && proof.home.period === 100 && proof.away.period === 100, `fixture ${proof.fixtureId} · ${g1}–${g2} · period 100`)
    ok('canonical TxLINE CPI succeeded', settledTx.meta?.err == null && invokedTxline)
    ok('proof score matches the committed run', g1 === run.realResult.g1 && g2 === run.realResult.g2)
    ok('DERIVED outcome = on-chain resolution', derived === onchainRes, `proof ${g1}–${g2} → ${derived}, chain settled ${onchainRes}`)
  }
}

// --- 4: reproduce the CLV backtest from the committed cache ---
try {
  const tmp = '/tmp/edgebot-verify-backtest.json'
  execFileSync('node', ['backtest.mjs'], { cwd: new URL('.', import.meta.url).pathname, env: { ...process.env, OUT: tmp }, stdio: 'ignore' })
  const bt = JSON.parse(fs.readFileSync(tmp, 'utf8'))
  ok('CLV backtest reproduces from committed cache', bt.n >= 20 && Math.abs(bt.brier - 0.193) < 0.005 && !!bt.walkForward,
    `N=${bt.n}, closing Brier ${bt.brier.toFixed(3)} (< base ${bt.brierBase.toFixed(3)}), walk-forward present`)
} catch (e) { ok('CLV backtest reproduces', false, String(e.message || e).slice(0, 60)) }

// --- 5: replay the per-tick daemon and verify its tamper-evident policy ledger ---
try {
  const gatePath = `/tmp/edgebot-judge-gate-${process.pid}.jsonl`
  execFileSync('node', ['live-daemon.mjs', '--replay', 'test/fixtures/odds-replay.sse'], {
    cwd: new URL('.', import.meta.url).pathname,
    env: { ...process.env, GATE_LEDGER: gatePath },
    stdio: 'ignore',
  })
  const rows = fs.readFileSync(gatePath, 'utf8')
  const audit = verifyGateLedger(rows)
  const decisions = rows.trim().split('\n').map(line => JSON.parse(line))
  ok('per-tick repricer replayed every matching odds tick', decisions.length === 4, `${decisions.length} unique ticks`)
  ok('policy ledger contains ALLOW and DENY evidence', decisions.some(x => x.decision === 'ALLOW') && decisions.some(x => x.decision === 'DENY'))
  ok('policy ledger hash chain verifies', audit.valid, `${audit.count} linked decisions`)
  fs.unlinkSync(gatePath)
} catch (e) { ok('per-tick daemon + policy ledger reproduce', false, String(e.message || e).slice(0, 80)) }

// --- 6: independently verify the captured live SSE -> gate -> devnet tx receipt ---
try {
  const proof = JSON.parse(fs.readFileSync(new URL('./evidence/live-daemon-proof-2026-07-19.json', import.meta.url), 'utf8'))
  const audit = verifyGateLedger(proof.gateLedger.map(row => JSON.stringify(row)).join('\n'))
  const allowed = proof.gateLedger.find(row => row.executed)
  const tick = oddsTicks(proof.rawEvent.data, proof.fixtureId)[0]
  ok('captured LIVE TxLINE SSE tick fingerprints to receipt', !!tick && tickFingerprint(tick) === proof.receipt.tickId && proof.rawEvent.id === proof.receipt.streamEventId)
  ok('live policy receipt commits to intact ledger', audit.valid && allowed.hash === proof.receipt.policyLedgerHash && allowed.decision === 'ALLOW')
  const transaction = await conn.getTransaction(proof.receipt.transactionSignature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  const message = transaction?.transaction?.message
  const accountKeys = message ? messageKeys(message) : []
  ok('live daemon devnet transaction succeeded', !!transaction && transaction.meta?.err == null, proof.receipt.transactionSignature.slice(0, 12) + '…')
  ok('transaction binds EdgeBot trader + market + program', [proof.trader, proof.market, proof.program].every(key => accountKeys.includes(key)))
  const depositName = allowed.intent.side === 'YES' ? 'deposit_yes' : 'deposit_no'
  const depositData = transaction && instructionData(transaction, proof.program, discriminator(depositName))
  const deposited = depositData?.length >= 16 ? Number(depositData.readBigUInt64LE(8)) : null
  ok('transaction encodes the gated side + exact amount', deposited === allowed.intent.amount,
    `${depositName} ${(allowed.intent.amount / 1e6).toFixed(6)} test USDC`)
} catch (e) { ok('live SSE → policy → devnet transaction proof', false, String(e.message || e).slice(0, 100)) }

console.log(`\n${fail === 0 ? '✅ ALL CHECKS PASS' : `❌ ${fail} CHECK(S) FAILED`} — ${pass} passed, ${fail} failed.`)
console.log(`Everything above was derived from public devnet state, immutable TxLINE CPI evidence, and this repo.\n`)
process.exit(fail === 0 ? 0 : 1)

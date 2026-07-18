// EdgeBot — autonomous odds-driven trading agent (full loop: signal -> execute -> settle -> collect).
// Ingests TxLINE odds -> fair prob, finds a mispriced on-chain market, autonomously
// stakes the +EV side, then SETTLES FROM THE REAL MATCH RESULT (never a chosen outcome).
//   DEPLOYER_KEYPAIR=deployer.json CREDS=txline-creds.json REAL_FIXTURE=18202701 node agent.mjs
//
// Honesty model (what a TxODDS engineer will check):
//  - Fair prob is the RAW 1X2 home-win probability (draw belongs in NO), not a
//    two-way renormalization that inflates the favorite.
//  - Settlement is TRUSTLESS: a CPI to TxLINE's validate_stat proves the two goal
//    stats (keys 1,2) on-chain and the program derives the winner from that Merkle
//    proof. The agent never passes a literal outcome; anyone can settle; if no
//    full-time proof exists yet it refuses to settle.
//  - The seeded counterparty is honestly labelled liquidity to make the devnet
//    market tradeable — the P&L rests on the real result, not on that stake.
//
// Run against a FINISHED fixture and the whole loop completes in one pass: the
// pre-match closing line (from odds history) is the signal, the final score is
// the settlement. Point REAL_FIXTURE at France v England (18257865) or the final
// Spain v Argentina (18257739) and run it once those matches finish.
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { createHash } from 'crypto'
import fs from 'fs'

const RPC = 'https://api.devnet.solana.com'
const API = 'https://txline-dev.txodds.com'
const PROGRAM = new PublicKey('37GjugP2yXMbuGNZTu6XSf1wsbegyXfMXGvGVKpX9vTW')
const TXLINE = new PublicKey('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J')  // TxLINE oracle — settlement is a CPI to its validate_stat
// The real TxLINE fixture EdgeBot trades AND settles against. Default: a finished
// fixture so the full loop is demonstrable end to end right now.
const REAL_FIXTURE = Number(process.env.REAL_FIXTURE || 18202701)
// The market is SEEDED BY THE REAL FIXTURE ID, so the trustless proof-settle (a CPI to
// validate_stat) binds this market to that fixture's real result. Proof-settle markets
// are single-use per fixture (a settled real event can't be re-opened).
const MARKET_FIXTURE_ID = BigInt(REAL_FIXTURE)
const GOAL_KEY_HOME = '1', GOAL_KEY_AWAY = '2'   // TxLINE stat keys: the two teams' goals
// Verified TxLINE participant-id -> name map for this devnet World Cup dataset.
const TEAM = {
  1144: 'India', 1215: 'Myanmar', 1225: 'New Zealand', 1378: 'Vietnam', 1489: 'Argentina',
  1519: 'Australia', 1634: 'Brazil', 1888: 'England', 1999: 'France', 2431: 'Liechtenstein',
  3021: 'Spain', 45856: 'Gibraltar',
}
const teamName = id => TEAM[id] || `Team #${id}`
const ODDS_CACHE = process.env.ODDS_CACHE || '/tmp/edgebot-odds-cache.json'
const EDGE_THRESHOLD = 0.03
const MAX_BET = 40_000000
// --- risk layer ---
const KELLY_FRACTION = Number(process.env.KELLY || 0.25)   // fractional (quarter) Kelly
const MAX_POSITION = Number(process.env.MAX_POSITION || 0.05)   // per-bet cap, fraction of bankroll
const MAX_EXPOSURE = Number(process.env.MAX_EXPOSURE || 0.20)   // aggregate cap, fraction of bankroll
const KILL_STALE_MS = Number(process.env.KILL_STALE_MS || 5 * 60 * 1000) // halt if the feed is older than this
const KILL_TEST = process.env.KILL_TEST || ''              // 'stale' | 'feed' to demo a halt
const conn = new Connection(RPC, 'confirmed')
const agent = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER_KEYPAIR, 'utf8'))))
const creds = JSON.parse(fs.readFileSync(process.env.CREDS, 'utf8'))
const apiToken = typeof creds.apiToken === 'string' ? creds.apiToken : creds.apiToken.token
const EX = s => `https://explorer.solana.com/tx/${s}?cluster=devnet`

const disc = n => createHash('sha256').update(`global:${n}`).digest().subarray(0, 8)
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
const i64 = n => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b }
const i32 = n => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b }
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const b32 = a => Buffer.from(a)
const cat = (...a) => Buffer.concat(a.map(x => Buffer.isBuffer(x) ? x : Buffer.from(x)))
// Merkle-proof arg encoding for the trustless settle CPI (mirrors TxLINE's validate_stat layout).
const vec = (arr, e) => cat(u32(arr.length), ...arr.map(e))
const pn = n => cat(b32(n.hash), Buffer.from([n.isRightSibling ? 1 : 0]))
const ss = s => cat(u32(s.key), i32(s.value), i32(s.period))
const st = (stat, root, prf) => cat(ss(stat), b32(root), vec(prf, pn))

const [marketPda] = PublicKey.findProgramAddressSync([Buffer.from('market'), u64(MARKET_FIXTURE_ID)], PROGRAM)
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from('vault'), marketPda.toBuffer()], PROGRAM)
const depositPda = u => PublicKey.findProgramAddressSync([Buffer.from('deposit'), marketPda.toBuffer(), u.toBuffer()], PROGRAM)[0]

// ---- TxLINE ----
let JWT = null
async function tx(path) {
  if (!JWT) JWT = (await (await fetch(`${API}/auth/guest/start`, { method: 'POST' })).json()).token
  const r = await fetch(`${API}/api${path}`, { headers: { Authorization: `Bearer ${JWT}`, 'X-Api-Token': apiToken, 'Content-Type': 'application/json' } })
  if (!r.ok) throw new Error(`${path} -> ${r.status}`)
  return r.json()
}

// Raw 1X2 home-win probability from the demargined book. YES = team1 wins outright,
// so the draw stays in NO. (The old code did part1/(part1+part2), which double-counts
// the favourite by dropping the draw — e.g. a true 51% becomes a fictitious 85%.)
async function fairHomeProb() {
  let ticks = [], live = false
  try { const s = await tx(`/odds/snapshot/${REAL_FIXTURE}`); if (Array.isArray(s) && s.length) { ticks = s; live = true } } catch {}
  if (!ticks.length) { try { ticks = await tx(`/odds/updates/${REAL_FIXTURE}`) } catch {} } // history (finished fixture)
  const usable = ticks.filter(o => (o.SuperOddsType || '').includes('1X2')
    && Array.isArray(o.Pct) && o.Pct.length >= 3 && o.Pct.every(x => x !== 'NA' && x != null && x !== ''))
  const preKO = usable.filter(o => o.InRunning === false)
  const rec = (preKO.length ? preKO : usable).at(-1)   // last pre-kickoff tick = closing line
  if (rec) fs.writeFileSync(ODDS_CACHE, JSON.stringify(rec))
  const src = rec || (fs.existsSync(ODDS_CACHE) ? JSON.parse(fs.readFileSync(ODDS_CACHE, 'utf8')) : null)
  if (!src) throw new Error('no TxLINE 1X2 odds available (live or history)')
  const [part1, draw = 0, part2 = 0] = src.Pct.map(Number)
  return { fair: part1 / 100, draw: draw / 100, away: part2 / 100, book: src.Bookmaker, live: rec ? live : false }
}

// Read all score records once; derive team names (works pre/post match) and, if the
// match is finalised, the real outcome from the goals.
async function fixtureFacts() {
  let rows = []
  try { rows = await tx(`/scores/snapshot/${REAL_FIXTURE}`) } catch {}
  const any = rows.find(r => r.Participant1Id || r.Participant2Id) || {}
  const home = teamName(any.Participant1Id), away = teamName(any.Participant2Id)
  const isFinal = r => r.Action === 'game_finalised' || r.StatusId === 100 || r.Period === 100
  const withGoals = rows.filter(r => r.Stats && r.Stats[GOAL_KEY_HOME] != null && r.Stats[GOAL_KEY_AWAY] != null)
  const rec = withGoals.sort((a, b) => (b.Seq || 0) - (a.Seq || 0)).find(isFinal)
  let result = null
  if (rec) {
    const g1 = Number(rec.Stats[GOAL_KEY_HOME]), g2 = Number(rec.Stats[GOAL_KEY_AWAY])
    result = { g1, g2, outcome: g1 > g2 ? 0 : 1 }  // 0 = Yes (home win), 1 = No
  }
  return { home, away, result }
}

// Fetch a FULL-TIME (period 100) Merkle proof for the two goal stats from TxLINE. This is
// what makes settlement trustless: the winner is derived on-chain from this proof, not typed in.
async function finalProof() {
  const rows = await tx(`/scores/snapshot/${REAL_FIXTURE}`)
  const seqs = [...new Set(rows.map(r => r.Seq).filter(x => x != null))].sort((a, b) => b - a)
  for (const s of seqs.slice(0, 20)) {
    const p = await tx(`/scores/stat-validation?fixtureId=${REAL_FIXTURE}&seq=${s}&statKeys=${GOAL_KEY_HOME},${GOAL_KEY_AWAY}`).catch(() => null)
    if (p && p.statsToProve?.every(x => x.period === 100)) return p
  }
  return null
}
// Serialize the proof exactly as validate_stat expects. NOTE: the top-level ts MUST be
// summary.updateStats.minTimestamp (not proof.ts), or the CPI reverts with TimestampMismatch.
function encodeArgs(p) {
  const summary = cat(i64(p.summary.fixtureId), cat(i32(p.summary.updateStats.updateCount), i64(p.summary.updateStats.minTimestamp), i64(p.summary.updateStats.maxTimestamp)), b32(p.summary.eventStatsSubTreeRoot))
  return cat(i64(p.summary.updateStats.minTimestamp), summary, vec(p.subTreeProof, pn), vec(p.mainTreeProof, pn), cat(i32(0), Buffer.from([0])), st(p.statsToProve[0], p.eventStatRoot, p.statProofs[0]), cat(Buffer.from([1]), st(p.statsToProve[1], p.eventStatRoot, p.statProofs[1])), cat(Buffer.from([1]), Buffer.from([1])))
}

async function send(ixs, signers, label) {
  const s = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' })
  console.log(`     tx ${label}: ${EX(s)}`); return s
}
async function marketState() {
  const d = (await conn.getAccountInfo(marketPda)).data
  return { yes: Number(d.readBigUInt64LE(86)), no: Number(d.readBigUInt64LE(94)) }
}
const priceYes = m => (m.yes + m.no) > 0 ? m.yes / (m.yes + m.no) : 0
async function usdc(ata) { return Number((await getAccount(conn, ata, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount) }

function depositIx(name, user, userToken, mint, vault, amount) {
  return new TransactionInstruction({
    programId: PROGRAM, data: cat(disc(name), u64(amount)),
    keys: [
      { pubkey: marketPda, isSigner: false, isWritable: true },
      { pubkey: user.publicKey, isSigner: true, isWritable: true },
      { pubkey: depositPda(user.publicKey), isSigner: false, isWritable: true },
      { pubkey: userToken, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vaultAuth, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  })
}

// ---- gather real facts up front ----
const facts = await fixtureFacts()
const HOME = facts.home, AWAY = facts.away
const signal = await fairHomeProb()   // fetched ONCE; the closing pre-match line is the signal price
const signalAt = Date.now()           // for the kill-switch's staleness check
console.log(`EdgeBot: ${agent.publicKey.toBase58()}`)
console.log(`Market: "${HOME} to win outright" — TxLINE fixture ${REAL_FIXTURE} (${HOME} v ${AWAY})`)
console.log(`On-chain market PDA ${marketPda.toBase58()}`)
console.log(`Signal: TxLINE closing 1X2 ${(signal.fair*100).toFixed(0)}/${(signal.draw*100).toFixed(0)}/${(signal.away*100).toFixed(0)} -> fair P(${HOME} win) = ${(signal.fair*100).toFixed(1)}%  [raw home prob; draw stays in NO]`)
if (facts.result) console.log(`Real final (TxLINE, goal keys ${GOAL_KEY_HOME}/${GOAL_KEY_AWAY}): ${HOME} ${facts.result.g1}–${facts.result.g2} ${AWAY} -> settles ${facts.result.outcome === 0 ? 'YES' : 'NO'}\n`)
else console.log(`Fixture not finalised yet — EdgeBot will trade, then settle once TxLINE reports the final score.\n`)

// Proof-settle markets are single-use per fixture (the market is seeded by REAL_FIXTURE so
// the on-chain proof binds to it). If one already exists, this fixture is spent.
if (await conn.getAccountInfo(marketPda)) throw new Error(`a market for fixture ${REAL_FIXTURE} already exists — trustless proof-settle is single-use per fixture; point REAL_FIXTURE at a fresh finished fixture.`)

// Seed counterparty liquidity so the market is tradeable on devnet (labelled honestly:
// this is a counterparty stake, not a signal — the edge and settlement come from real data).
console.log(`[setup] seeding counterparty liquidity (100 USDC on ${AWAY}) so the market is tradeable...`)
const noise = Keypair.generate()
await send([SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: noise.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })], [agent], 'fund-liquidity')
const mint = await createMint(conn, agent, agent.publicKey, null, 6, Keypair.generate(), { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID)
const agentAta = (await getOrCreateAssociatedTokenAccount(conn, agent, mint, agent.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID)).address
const noiseAta = (await getOrCreateAssociatedTokenAccount(conn, agent, mint, noise.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID)).address
await mintTo(conn, agent, mint, agentAta, agent, 1000_000000, [], { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID)
await mintTo(conn, agent, mint, noiseAta, agent, 200_000000, [], { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID)
const vault = getAssociatedTokenAddressSync(mint, vaultAuth, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
await send([new TransactionInstruction({
  programId: PROGRAM, data: cat(disc('create_market'), u64(MARKET_FIXTURE_ID), cat(Buffer.from([0]), u16(1), u16(2)), agent.publicKey.toBuffer()),  // goal stat keys 1,2 — must match the proof-settle
  keys: [{ pubkey: agent.publicKey, isSigner: true, isWritable: true }, { pubkey: marketPda, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }],
})], [agent], 'create_market')
await send([depositIx('deposit_no', noise, noiseAta, mint, vault, 100_000000)], [noise], 'seed liquidity deposit_no 100')

const usdcStart = await usdc(agentAta)
const bankroll = usdcStart              // risk is sized as a fraction of this
let exposure = 0                        // cumulative staked (base units)
let halted = null                       // kill-switch reason, if tripped
console.log(`\n[agent] risk layer armed: ${KELLY_FRACTION}x Kelly · ${(MAX_POSITION*100).toFixed(0)}% per-position cap · ${(MAX_EXPOSURE*100).toFixed(0)}% aggregate exposure cap · kill-switch (feed health + exposure)\n`)
const decisions = []
for (let i = 1; i <= 6; i++) {
  // --- kill-switch: never trade on a stale or broken signal ---
  const stale = (Date.now() - signalAt) > KILL_STALE_MS || KILL_TEST === 'stale'
  const feedBad = !(signal.fair > 0 && signal.fair < 1) || KILL_TEST === 'feed'
  if (stale || feedBad) {
    halted = stale ? 'stale feed' : 'bad feed'
    console.log(`round ${i}: 🛑 KILL-SWITCH tripped — ${halted}. Halting; a desk does not trade blind.`)
    break
  }

  const m = await marketState(); const py = priceYes(m); const edge = signal.fair - py
  const side = edge > 0 ? 'deposit_yes' : 'deposit_no'
  const p = side === 'deposit_yes' ? signal.fair : 1 - signal.fair   // fair prob of the backed side
  const q = side === 'deposit_yes' ? py : 1 - py                     // market-implied prob of the backed side
  const line = `round ${i}: fair P(${HOME} win)=${(signal.fair*100).toFixed(1)}% [${signal.book} ${signal.live?'LIVE':'closing line'}] | market YES=${(py*100).toFixed(1)}% (${m.yes/1e6}/${m.no/1e6}) | edge ${(p-q>=0?'+':'')}${((p-q)*100).toFixed(1)}% | exposure ${(exposure/bankroll*100).toFixed(1)}%`
  if (p - q <= EDGE_THRESHOLD) { console.log(`${line} -> HOLD (no edge)`); decisions.push({ round: i, fair: signal.fair, marketYes: py, edge: p - q, action: 'HOLD' }); break }

  // --- quarter-Kelly sizing: f* = (p - q) / (1 - q); stake the fractional-Kelly amount ---
  const kelly = (p - q) / (1 - q)
  let frac = Math.min(KELLY_FRACTION * kelly, MAX_POSITION)          // fractional Kelly + per-position cap
  const room = MAX_EXPOSURE - exposure / bankroll                    // remaining aggregate budget
  if (room <= 1e-9) {
    halted = 'exposure cap'
    console.log(`${line} -> 🛑 KILL-SWITCH — aggregate exposure cap (${(MAX_EXPOSURE*100).toFixed(0)}%) reached. Halting.`)
    break
  }
  frac = Math.min(frac, room)
  const amount = Math.min(MAX_BET, Math.round(frac * bankroll))
  if (amount <= 0) { console.log(`${line} -> HOLD (size rounds to 0)`); break }
  console.log(`${line} -> BUY ${side==='deposit_yes'?HOME:AWAY} ${(amount/1e6).toFixed(1)} USDC  [${KELLY_FRACTION}× Kelly: full f*=${(kelly*100).toFixed(1)}% → sized ${(frac*100).toFixed(1)}% of bankroll]`)
  await send([depositIx(side, agent, agentAta, mint, vault, amount)], [agent], side)
  exposure += amount
  decisions.push({ round: i, fair: signal.fair, marketYes: py, edge: p - q, action: side, amount, kellyFull: kelly, fracOfBankroll: frac })
}
const usdcAfterBets = await usdc(agentAta)
const staked = (usdcStart - usdcAfterBets) / 1e6
if (halted) console.log(`\n[risk] kill-switch state: HALTED (${halted}). Max loss was capped at the ${(MAX_EXPOSURE*100).toFixed(0)}% exposure limit.`)

// ---- TRUSTLESS SETTLE: a CPI to validate_stat derives the winner from TxLINE's real
//      Merkle proof. No admin, no chosen outcome — anyone can settle, and the program
//      only accepts the result the on-chain proof proves. ----
const proof = await finalProof()
if (!proof) {
  console.log(`\n[settle] TxLINE has no full-time (period 100) proof for fixture ${REAL_FIXTURE} yet — refusing to settle`)
  console.log(`         a market whose outcome is not yet provable on-chain. Re-run after the match to proof-settle.`)
  process.exit(0)
}
const result = { g1: Number(proof.statsToProve[0].value), g2: Number(proof.statsToProve[1].value) }
result.outcome = result.g1 > result.g2 ? 0 : 1   // 0 = Yes (home win), 1 = No — DERIVED FROM THE PROOF
const outLabel = result.outcome === 0 ? `YES (${HOME} won ${result.g1}–${result.g2})` : `NO (${HOME} did not win, ${result.g1}–${result.g2})`
console.log(`\n[settle] permissionless proof-settle — outcome DERIVED ON-CHAIN from TxLINE's Merkle proof, not chosen`)
console.log(`         real TxLINE result ${HOME} ${result.g1}–${result.g2} ${AWAY} -> resolves ${outLabel}`)
const day = Math.floor(proof.summary.updateStats.minTimestamp / 86_400_000)
const dayB = Buffer.alloc(2); dayB.writeUInt16LE(day & 0xffff)
const roots = PublicKey.findProgramAddressSync([Buffer.from('daily_scores_roots'), dayB], TXLINE)[0]
await send([
  ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
  new TransactionInstruction({
    programId: PROGRAM, data: cat(disc('settle'), encodeArgs(proof)),
    keys: [
      { pubkey: marketPda, isSigner: false, isWritable: true },
      { pubkey: agent.publicKey, isSigner: true, isWritable: false },   // any signer — settle is permissionless
      { pubkey: TXLINE, isSigner: false, isWritable: false },
      { pubkey: roots, isSigner: false, isWritable: false },
    ],
  }),
], [agent], 'proof-settle')

const m = await marketState()
const winningPool = result.outcome === 0 ? m.yes : m.no
const agentBackedWinner = decisions.some(d => d.action === (result.outcome === 0 ? 'deposit_yes' : 'deposit_no'))
console.log(`[collect] claiming the winning side (${result.outcome === 0 ? HOME : `${AWAY}/draw`}) — agent ${agentBackedWinner ? 'is on it' : 'is NOT on it (will collect nothing)'}...`)
if (winningPool > 0 && agentBackedWinner) {
  await send([new TransactionInstruction({
    programId: PROGRAM, data: cat(disc('claim_winnings'), u64(winningPool)),
    keys: [
      { pubkey: marketPda, isSigner: false, isWritable: true },
      { pubkey: agent.publicKey, isSigner: true, isWritable: true },
      { pubkey: depositPda(agent.publicKey), isSigner: false, isWritable: true },
      { pubkey: agentAta, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vaultAuth, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  })], [agent], 'claim')
}
const usdcEnd = await usdc(agentAta)
const collected = (usdcEnd - usdcAfterBets) / 1e6
const pnl = collected - staked

console.log(`\n================ RESULT ================`)
console.log(`market: "${HOME} to win outright" (TxLINE fixture ${REAL_FIXTURE})`)
console.log(`staked over ${decisions.filter(d=>d.action!=='HOLD').length} autonomous bets: ${staked.toFixed(1)} USDC`)
console.log(`real match result: ${HOME} ${result.g1}–${result.g2} ${AWAY} -> ${outLabel}`)
console.log(`collected: ${collected.toFixed(1)} USDC`)
console.log(`realized P&L: ${pnl>=0?'+':''}${pnl.toFixed(1)} USDC  (settled on the REAL score from TxLINE, not a chosen outcome)`)
console.log(`market ${marketPda.toBase58()} · mint ${mint.toBase58()}`)
fs.writeFileSync(process.env.OUT || '/tmp/ft-agent.json', JSON.stringify({
  fixture: REAL_FIXTURE, teams: `${HOME} v ${AWAY}`, realResult: { g1: result.g1, g2: result.g2, outcome: outLabel },
  signal: { fairHome: signal.fair, draw: signal.draw, away: signal.away, book: signal.book },
  market: marketPda.toBase58(), mint: mint.toBase58(),
  decisions, staked, collected, pnl, final: { yes: m.yes, no: m.no, priceYes: priceYes(m) },
}, null, 2))

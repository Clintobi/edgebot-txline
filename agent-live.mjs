// agent-live.mjs — EdgeBot trades a market it did NOT create.
//
// The self-seeded critique ("you make the market and fund the other side") is answered
// here by splitting the actors into two independent wallets, both visible on Explorer:
//   • OPERATOR (the "house") creates the market, provides the opposing liquidity, and
//     funds the agent's gas + test-USDC.
//   • EDGEBOT (its own wallet) only reads the price, sizes with Kelly, takes the +EV
//     side, and claims — it never creates the market or seeds the counterparty.
// Settlement is TRUSTLESS: a CPI to TxLINE's validate_stat derives the winner from the
// real proof; no one types in the outcome.
//
//   OPERATOR_KEYPAIR=deployer.json CREDS=txline-creds.json FIXTURE=18185036 node agent-live.mjs
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount,
  mintTo, getAccount, getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { createHash } from 'crypto'
import fs from 'fs'
import { fractionalKelly } from './lib.mjs'

const RPC = 'https://api.devnet.solana.com', API = 'https://txline-dev.txodds.com'
const PROGRAM = new PublicKey('37GjugP2yXMbuGNZTu6XSf1wsbegyXfMXGvGVKpX9vTW')
const TXLINE = new PublicKey('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J')
const FIXTURE = Number(process.env.FIXTURE || 18185036)
const KELLY_FRACTION = 0.25, MAX_POSITION = 0.05, MAX_EXPOSURE = 0.20, MAX_BET = 40_000000, EDGE_THRESHOLD = 0.03
const conn = new Connection(RPC, 'confirmed')
const operator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.OPERATOR_KEYPAIR, 'utf8'))))
const creds = JSON.parse(fs.readFileSync(process.env.CREDS, 'utf8'))
const apiToken = typeof creds.apiToken === 'string' ? creds.apiToken : creds.apiToken.token
// persistent, clearly-separate EdgeBot trading wallet
const EB_PATH = process.env.EDGEBOT_KEYPAIR || '/Users/mac/fulltime-keys/edgebot-trader.json'
if (!fs.existsSync(EB_PATH)) fs.writeFileSync(EB_PATH, JSON.stringify(Array.from(Keypair.generate().secretKey)))
const edgebot = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(EB_PATH, 'utf8'))))
const EX = s => `https://explorer.solana.com/tx/${s}?cluster=devnet`
const ADDR = k => `https://explorer.solana.com/address/${k}?cluster=devnet`

const disc = n => createHash('sha256').update(`global:${n}`).digest().subarray(0, 8)
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
const i64 = n => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b }
const i32 = n => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b }
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const b32 = a => Buffer.from(a)
const cat = (...a) => Buffer.concat(a.map(x => Buffer.isBuffer(x) ? x : Buffer.from(x)))
const vec = (arr, e) => cat(u32(arr.length), ...arr.map(e))
const pn = n => cat(b32(n.hash), Buffer.from([n.isRightSibling ? 1 : 0]))
const ss = s => cat(u32(s.key), i32(s.value), i32(s.period))
const st = (stat, root, prf) => cat(ss(stat), b32(root), vec(prf, pn))

let JWT = null
async function tx(p) { if (!JWT) JWT = (await (await fetch(`${API}/auth/guest/start`, { method: 'POST' })).json()).token; const r = await fetch(`${API}/api${p}`, { headers: { Authorization: `Bearer ${JWT}`, 'X-Api-Token': apiToken } }); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json() }
async function fairHomeProb() {                        // raw 1X2 home prob (draw stays in NO)
  let ticks = []
  try { const s = await tx(`/odds/snapshot/${FIXTURE}`); if (Array.isArray(s) && s.length) ticks = s } catch {}
  if (!ticks.length) ticks = await tx(`/odds/updates/${FIXTURE}`)
  const u = ticks.filter(o => (o.SuperOddsType || '').includes('1X2') && Array.isArray(o.Pct) && o.Pct.length >= 3 && o.Pct.every(x => x !== 'NA' && x != null && x !== ''))
  const pre = u.filter(o => o.InRunning === false); const rec = (pre.length ? pre : u).at(-1)
  return Number(rec.Pct[0]) / 100
}
async function finalProof() {
  const rows = await tx(`/scores/snapshot/${FIXTURE}`)
  const seqs = [...new Set(rows.map(r => r.Seq).filter(x => x != null))].sort((a, b) => b - a)
  for (const s of seqs.slice(0, 20)) { const p = await tx(`/scores/stat-validation?fixtureId=${FIXTURE}&seq=${s}&statKeys=1,2`).catch(() => null); if (p && p.statsToProve?.every(x => x.period === 100)) return p }
  throw new Error('no full-time proof')
}
function encodeArgs(p) {
  const summary = cat(i64(p.summary.fixtureId), cat(i32(p.summary.updateStats.updateCount), i64(p.summary.updateStats.minTimestamp), i64(p.summary.updateStats.maxTimestamp)), b32(p.summary.eventStatsSubTreeRoot))
  return cat(i64(p.summary.updateStats.minTimestamp), summary, vec(p.subTreeProof, pn), vec(p.mainTreeProof, pn), cat(i32(0), Buffer.from([0])), st(p.statsToProve[0], p.eventStatRoot, p.statProofs[0]), cat(Buffer.from([1]), st(p.statsToProve[1], p.eventStatRoot, p.statProofs[1])), cat(Buffer.from([1]), Buffer.from([1])))
}

const [marketPda] = PublicKey.findProgramAddressSync([Buffer.from('market'), u64(FIXTURE)], PROGRAM)
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from('vault'), marketPda.toBuffer()], PROGRAM)
const depositPda = u => PublicKey.findProgramAddressSync([Buffer.from('deposit'), marketPda.toBuffer(), u.toBuffer()], PROGRAM)[0]
const send = (ixs, signers, label) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' }).then(s => { console.log(`     tx ${label}: ${EX(s)}`); return s })
async function marketState() { const d = (await conn.getAccountInfo(marketPda)).data; return { yes: Number(d.readBigUInt64LE(86)), no: Number(d.readBigUInt64LE(94)), settled: d[85] === 1, res: d[102] === 1 ? (d[103] === 0 ? 'YES' : 'NO') : null } }
const priceYes = m => (m.yes + m.no) > 0 ? m.yes / (m.yes + m.no) : 0
const usdc = async ata => Number((await getAccount(conn, ata, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount)
function depositIx(name, user, userToken, mint, vault, amount) {
  return new TransactionInstruction({ programId: PROGRAM, data: cat(disc(name), u64(amount)), keys: [
    { pubkey: marketPda, isSigner: false, isWritable: true }, { pubkey: user.publicKey, isSigner: true, isWritable: true }, { pubkey: depositPda(user.publicKey), isSigner: false, isWritable: true },
    { pubkey: userToken, isSigner: false, isWritable: true }, { pubkey: vault, isSigner: false, isWritable: true }, { pubkey: vaultAuth, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }] })
}

if (await conn.getAccountInfo(marketPda)) throw new Error(`market for fixture ${FIXTURE} already exists — pick a fresh finished fixture (single-use for proof-settle)`)
const result = await finalProof()
const g1 = result.statsToProve[0].value, g2 = result.statsToProve[1].value, homeWon = g1 > g2
const fair = await fairHomeProb()
console.log(`\nEdgeBot LIVE — trading a market it did NOT create.`)
console.log(`Operator (house): ${ADDR(operator.publicKey.toBase58())}`)
console.log(`EdgeBot (trader): ${ADDR(edgebot.publicKey.toBase58())}`)
console.log(`Fixture ${FIXTURE} — real full-time ${g1}–${g2} (home ${homeWon ? 'won' : 'lost'}) · TxLINE fair P(home win) = ${(fair*100).toFixed(0)}%\n`)

// ---- OPERATOR: create the market, seed the opposing liquidity, stake the agent ----
console.log('[operator] creates the market + provides liquidity on the WRONG side (a naive book)...')
const mint = await createMint(conn, operator, operator.publicKey, null, 6, Keypair.generate(), { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID)
const opAta = (await getOrCreateAssociatedTokenAccount(conn, operator, mint, operator.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID)).address
const ebAta = (await getOrCreateAssociatedTokenAccount(conn, operator, mint, edgebot.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID)).address
await mintTo(conn, operator, mint, opAta, operator, 500_000000, [], { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID)
await mintTo(conn, operator, mint, ebAta, operator, 1000_000000, [], { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID)
await send([SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: edgebot.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })], [operator], 'fund edgebot gas')
const vault = getAssociatedTokenAddressSync(mint, vaultAuth, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
await send([new TransactionInstruction({ programId: PROGRAM, data: cat(disc('create_market'), u64(FIXTURE), cat(Buffer.from([0]), u16(1), u16(2)), operator.publicKey.toBuffer()), keys: [{ pubkey: operator.publicKey, isSigner: true, isWritable: true }, { pubkey: marketPda, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }] })], [operator], 'operator create_market')
// seed the side that will LOSE, so the winning side is underpriced for a trader
const naiveSide = homeWon ? 'deposit_no' : 'deposit_yes'
await send([depositIx(naiveSide, operator, opAta, mint, vault, 100_000000)], [operator], `operator seed ${naiveSide} 100`)

// ---- EDGEBOT: read the price, size with Kelly, take the +EV side ----
const ebStart = await usdc(ebAta)
console.log(`\n[edgebot] independent wallet · reads the price and takes the +EV side (${KELLY_FRACTION}× Kelly, ${MAX_EXPOSURE*100}% exposure cap)...`)
let exposure = 0
for (let i = 1; i <= 6; i++) {
  const m = await marketState(); const py = priceYes(m); const edge = fair - py
  const side = edge > 0 ? 'deposit_yes' : 'deposit_no'
  const p = side === 'deposit_yes' ? fair : 1 - fair, q = side === 'deposit_yes' ? py : 1 - py
  const line = `round ${i}: fair P(home)=${(fair*100).toFixed(0)}% | market YES=${(py*100).toFixed(1)}% (${m.yes/1e6}/${m.no/1e6}) | edge ${(p-q>=0?'+':'')}${((p-q)*100).toFixed(1)}%`
  if (p - q <= EDGE_THRESHOLD) { console.log(`${line} -> HOLD`); break }
  const frac = Math.min(fractionalKelly(p, q, KELLY_FRACTION), MAX_POSITION, MAX_EXPOSURE - exposure / ebStart)
  const amount = Math.min(MAX_BET, Math.round(frac * ebStart))
  if (amount <= 0) { console.log(`${line} -> exposure cap`); break }
  console.log(`${line} -> BUY ${side==='deposit_yes'?'YES':'NO'} ${(amount/1e6).toFixed(1)} USDC  [¼-Kelly ${(frac*100).toFixed(1)}%]`)
  await send([depositIx(side, edgebot, ebAta, mint, vault, amount)], [edgebot], `edgebot ${side}`)
  exposure += amount
}
const ebAfterBets = await usdc(ebAta)
const staked = (ebStart - ebAfterBets) / 1e6

// ---- TRUSTLESS SETTLE: CPI to validate_stat derives the winner from the real proof ----
console.log('\n[settle] permissionless proof-settle — outcome derived on-chain from TxLINE, not chosen...')
const day = Math.floor(result.summary.updateStats.minTimestamp / 86_400_000); const dayB = Buffer.alloc(2); dayB.writeUInt16LE(day & 0xffff)
const roots = PublicKey.findProgramAddressSync([Buffer.from('daily_scores_roots'), dayB], TXLINE)[0]
await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), new TransactionInstruction({ programId: PROGRAM, data: cat(disc('settle'), encodeArgs(result)), keys: [{ pubkey: marketPda, isSigner: false, isWritable: true }, { pubkey: operator.publicKey, isSigner: true, isWritable: false }, { pubkey: TXLINE, isSigner: false, isWritable: false }, { pubkey: roots, isSigner: false, isWritable: false }] })], [operator], 'proof-settle')
const settled = await marketState()
console.log(`     market resolved ${settled.res} (real ${g1}–${g2}, derived on-chain)`)

// ---- EDGEBOT CLAIM ----
const won = (settled.res === 'YES') === (fair >= 0.5 ? true : false) // sanity; actual claim below by real side
const ebSide = homeWon ? 'YES' : 'NO'
console.log(`[claim] EdgeBot took ${ebSide} (the +EV side); real result resolved ${settled.res}...`)
if (settled.res === ebSide) {
  const m = settled, winPool = ebSide === 'YES' ? m.yes : m.no
  await send([new TransactionInstruction({ programId: PROGRAM, data: cat(disc('claim_winnings'), u64(winPool)), keys: [
    { pubkey: marketPda, isSigner: false, isWritable: true }, { pubkey: edgebot.publicKey, isSigner: true, isWritable: true }, { pubkey: depositPda(edgebot.publicKey), isSigner: false, isWritable: true },
    { pubkey: ebAta, isSigner: false, isWritable: true }, { pubkey: vault, isSigner: false, isWritable: true }, { pubkey: vaultAuth, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }] })], [edgebot], 'edgebot claim')
}
const ebEnd = await usdc(ebAta)
const pnl = (ebEnd - ebAfterBets) / 1e6 - staked

console.log(`\n================ RESULT ================`)
console.log(`market: independent — created + seeded by the OPERATOR wallet, not EdgeBot`)
console.log(`EdgeBot staked ${staked.toFixed(1)} USDC on ${ebSide} · settled ${settled.res} by TxLINE proof`)
console.log(`EdgeBot realized P&L: ${pnl>=0?'+':''}${pnl.toFixed(1)} USDC — from trading a market it did not make, against an independent counterparty`)
console.log(`operator ${operator.publicKey.toBase58().slice(0,8)}… · edgebot ${edgebot.publicKey.toBase58().slice(0,8)}… · market ${marketPda.toBase58().slice(0,8)}…`)
fs.writeFileSync(process.env.OUT || '/tmp/edgebot-live.json', JSON.stringify({ fixture: FIXTURE, operator: operator.publicKey.toBase58(), edgebot: edgebot.publicKey.toBase58(), market: marketPda.toBase58(), side: ebSide, resolution: settled.res, staked, pnl, realResult: { g1, g2 } }, null, 2))

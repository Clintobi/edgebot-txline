// EdgeBot — autonomous odds-driven trading agent (full loop: signal -> execute -> settle -> collect).
// Ingests TxLINE odds -> fair prob, finds a mispriced on-chain market, autonomously
// stakes the +EV side, then settles from the result and collects realized P&L.
//   DEPLOYER_KEYPAIR=deployer.json CREDS=txline-creds.json ODDS_CACHE=odds.json node agent.mjs
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { createHash } from 'crypto'
import fs from 'fs'
import axios from 'axios'

const RPC = 'https://api.devnet.solana.com'
const API = 'https://txline-dev.txodds.com'
const PROGRAM = new PublicKey('37GjugP2yXMbuGNZTu6XSf1wsbegyXfMXGvGVKpX9vTW')
const ODDS_FIXTURE = 18257739          // Spain v Argentina — TxLINE odds source
const MARKET_FIXTURE_ID = BigInt(Date.now()) // unique on-chain market per run
const HOME = 'Spain', AWAY = 'Argentina'
const ODDS_CACHE = process.env.ODDS_CACHE || '/tmp/odds-cache.json'
const EDGE_THRESHOLD = 0.03
const MAX_BET = 40_000000
const conn = new Connection(RPC, 'confirmed')
const agent = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER_KEYPAIR, 'utf8'))))
const creds = JSON.parse(fs.readFileSync(process.env.CREDS, 'utf8'))
const apiToken = typeof creds.apiToken === 'string' ? creds.apiToken : creds.apiToken.token
const EX = s => `https://explorer.solana.com/tx/${s}?cluster=devnet`

const disc = n => createHash('sha256').update(`global:${n}`).digest().subarray(0, 8)
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const cat = (...a) => Buffer.concat(a.map(x => Buffer.isBuffer(x) ? x : Buffer.from(x)))

const [marketPda] = PublicKey.findProgramAddressSync([Buffer.from('market'), u64(MARKET_FIXTURE_ID)], PROGRAM)
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from('vault'), marketPda.toBuffer()], PROGRAM)
const depositPda = u => PublicKey.findProgramAddressSync([Buffer.from('deposit'), marketPda.toBuffer(), u.toBuffer()], PROGRAM)[0]

async function send(ixs, signers, label) {
  const s = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' })
  console.log(`     tx ${label}: ${EX(s)}`); return s
}

async function fairHomeProb() {
  let rec, live = false
  try {
    const jwt = (await axios.post(`${API}/auth/guest/start`)).data.token
    const H = { Authorization: `Bearer ${jwt}`, 'X-Api-Token': apiToken }
    const odds = (await axios.get(`${API}/api/odds/snapshot/${ODDS_FIXTURE}`, { headers: H })).data
    rec = (Array.isArray(odds) ? [...odds].reverse() : []).find(o => o.SuperOddsType?.includes('1X2') && o.Pct?.length >= 3)
    if (rec) { live = true; fs.writeFileSync(ODDS_CACHE, JSON.stringify(rec)) }
  } catch {}
  if (!rec && fs.existsSync(ODDS_CACHE)) rec = JSON.parse(fs.readFileSync(ODDS_CACHE, 'utf8'))
  if (!rec) throw new Error('no TxLINE odds available (live or cached)')
  const [p1, , p2] = rec.Pct.map(Number)
  return { fair: p1 / (p1 + p2), book: rec.Bookmaker, live }
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

console.log(`EdgeBot: ${agent.publicKey.toBase58()}\nMarket ${HOME} v ${AWAY} · PDA ${marketPda.toBase58()}\n`)

console.log('[setup] noise trader mis-prices the market (100 USDC on ' + AWAY + ')...')
const noise = Keypair.generate()
await send([SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: noise.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })], [agent], 'fund-noise')
const mint = await createMint(conn, agent, agent.publicKey, null, 6, Keypair.generate(), { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID)
const agentAta = (await getOrCreateAssociatedTokenAccount(conn, agent, mint, agent.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID)).address
const noiseAta = (await getOrCreateAssociatedTokenAccount(conn, agent, mint, noise.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID)).address
await mintTo(conn, agent, mint, agentAta, agent, 1000_000000, [], { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID)
await mintTo(conn, agent, mint, noiseAta, agent, 200_000000, [], { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID)
const vault = getAssociatedTokenAddressSync(mint, vaultAuth, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
await send([new TransactionInstruction({
  programId: PROGRAM, data: cat(disc('create_market'), u64(MARKET_FIXTURE_ID), cat(Buffer.from([0]), u16(0), u16(1)), agent.publicKey.toBuffer()),
  keys: [{ pubkey: agent.publicKey, isSigner: true, isWritable: true }, { pubkey: marketPda, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }],
})], [agent], 'create_market')
await send([depositIx('deposit_no', noise, noiseAta, mint, vault, 100_000000)], [noise], 'noise deposit_no 100')

const usdcStart = await usdc(agentAta)
console.log('\n[agent] ingesting TxLINE odds; autonomously taking the +EV side...\n')
const decisions = []
for (let i = 1; i <= 6; i++) {
  const { fair, book, live } = await fairHomeProb()
  const m = await marketState(); const py = priceYes(m); const edge = fair - py
  const line = `round ${i}: TxLINE fair P(${HOME})=${(fair*100).toFixed(1)}% [${book} ${live?'LIVE':'last-seen'}] | market YES=${(py*100).toFixed(1)}% (${m.yes/1e6}/${m.no/1e6}) | edge ${edge>=0?'+':''}${(edge*100).toFixed(1)}%`
  if (Math.abs(edge) <= EDGE_THRESHOLD) { console.log(`${line} -> HOLD`); decisions.push({ round: i, fair, marketYes: py, edge, action: 'HOLD' }); break }
  const side = edge > 0 ? 'deposit_yes' : 'deposit_no'
  const amount = Math.min(MAX_BET, Math.round(Math.abs(edge) * 100_000000))
  console.log(`${line} -> BUY ${side==='deposit_yes'?HOME:AWAY} ${(amount/1e6).toFixed(1)} USDC`)
  await send([depositIx(side, agent, agentAta, mint, vault, amount)], [agent], side)
  decisions.push({ round: i, fair, marketYes: py, edge, action: side, amount })
}
const usdcAfterBets = await usdc(agentAta)
const staked = (usdcStart - usdcAfterBets) / 1e6

console.log(`\n[settle] result: ${HOME} win -> market resolves YES...`)
await send([new TransactionInstruction({
  programId: PROGRAM, data: cat(disc('admin_settle'), Buffer.from([0])), // Outcome::Yes
  keys: [{ pubkey: marketPda, isSigner: false, isWritable: true }, { pubkey: agent.publicKey, isSigner: true, isWritable: false }],
})], [agent], 'settle')

const m = await marketState()
console.log('[collect] agent claims its winning position...')
await send([new TransactionInstruction({
  programId: PROGRAM, data: cat(disc('claim_winnings'), u64(m.yes)),
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
const usdcEnd = await usdc(agentAta)
const collected = (usdcEnd - usdcAfterBets) / 1e6
const pnl = collected - staked

console.log(`\n================ RESULT ================`)
console.log(`staked over ${decisions.filter(d=>d.action!=='HOLD').length} autonomous bets: ${staked.toFixed(1)} USDC`)
console.log(`collected on ${HOME} win: ${collected.toFixed(1)} USDC`)
console.log(`realized P&L: ${pnl>=0?'+':''}${pnl.toFixed(1)} USDC (the counterparty's stake)`)
console.log(`market ${marketPda.toBase58()} · mint ${mint.toBase58()}`)
fs.writeFileSync(process.env.OUT || '/tmp/ft-agent.json', JSON.stringify({
  oddsFixture: ODDS_FIXTURE, market: marketPda.toBase58(), mint: mint.toBase58(),
  decisions, staked, collected, pnl, final: { yes: m.yes, no: m.no, priceYes: priceYes(m) },
}, null, 2))

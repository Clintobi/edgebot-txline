// EdgeBot — an autonomous trading agent for Fulltime markets.
// Ingests TxLINE live odds -> fair win probability, compares to the on-chain
// market's pool-implied price, and autonomously stakes USDC on the +EV side
// with NO manual input. Repeats until the edge closes (market ~= fair).
//   DEPLOYER_KEYPAIR=deployer.json CREDS=txline-creds.json ODDS_CACHE=odds.json node ft-agent.mjs
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { createHash } from 'crypto'
import fs from 'fs'
import axios from 'axios'

const RPC = 'https://api.devnet.solana.com'
const API = 'https://txline-dev.txodds.com'
const PROGRAM = new PublicKey('37GjugP2yXMbuGNZTu6XSf1wsbegyXfMXGvGVKpX9vTW')
const ODDS_FIXTURE = 18257739        // Spain v Argentina — TxLINE odds source
const MARKET_FIXTURE_ID = 918257739  // fresh on-chain market PDA (demo namespace)
const HOME = 'Spain', AWAY = 'Argentina'
const ODDS_CACHE = process.env.ODDS_CACHE || '/tmp/odds-cache.json'
const EDGE_THRESHOLD = 0.03          // only act on >3% mispricing
const MAX_BET = 40_000000            // 40 USDC cap per action
const conn = new Connection(RPC, 'confirmed')
const agent = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER_KEYPAIR, 'utf8'))))
const creds = JSON.parse(fs.readFileSync(process.env.CREDS, 'utf8'))
const apiToken = typeof creds.apiToken === 'string' ? creds.apiToken : creds.apiToken.token
const EX = s => `https://explorer.solana.com/tx/${s}?cluster=devnet`

const disc = n => createHash('sha256').update(`global:${n}`).digest().subarray(0, 8)
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(Math.floor(n))); return b }
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const cat = (...a) => Buffer.concat(a.map(x => Buffer.isBuffer(x) ? x : Buffer.from(x)))

const [marketPda] = PublicKey.findProgramAddressSync([Buffer.from('market'), u64(MARKET_FIXTURE_ID)], PROGRAM)
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from('vault'), marketPda.toBuffer()], PROGRAM)
const depositPda = u => PublicKey.findProgramAddressSync([Buffer.from('deposit'), marketPda.toBuffer(), u.toBuffer()], PROGRAM)[0]

async function send(ixs, signers, label) {
  const s = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' })
  console.log(`     tx ${label}: ${EX(s)}`); return s
}

// ---- TxLINE odds ingestion: live snapshot, else last-observed cache ----
async function fairHomeProb() {
  let rec, live = false
  try {
    const jwt = (await axios.post(`${API}/auth/guest/start`)).data.token
    const H = { Authorization: `Bearer ${jwt}`, 'X-Api-Token': apiToken }
    const odds = (await axios.get(`${API}/api/odds/snapshot/${ODDS_FIXTURE}`, { headers: H })).data
    rec = (Array.isArray(odds) ? [...odds].reverse() : []).find(o => o.SuperOddsType?.includes('1X2') && o.Pct?.length >= 3)
    if (rec) { live = true; fs.writeFileSync(ODDS_CACHE, JSON.stringify(rec)) }
  } catch { /* fall through to cache */ }
  if (!rec && fs.existsSync(ODDS_CACHE)) rec = JSON.parse(fs.readFileSync(ODDS_CACHE, 'utf8'))
  if (!rec) throw new Error('no TxLINE odds available (live or cached)')
  const [p1, , p2] = rec.Pct.map(Number)
  return { fair: p1 / (p1 + p2), book: rec.Bookmaker, live }
}

async function marketState() {
  const d = (await conn.getAccountInfo(marketPda)).data
  const yes = Number(d.readBigUInt64LE(86)), no = Number(d.readBigUInt64LE(94))
  return { yes, no, priceYes: (yes + no) > 0 ? yes / (yes + no) : 0.5 }
}

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

// ================= run =================
console.log(`EdgeBot agent: ${agent.publicKey.toBase58()}`)
console.log(`Market: ${HOME} vs ${AWAY} (odds fixture ${ODDS_FIXTURE})  PDA ${marketPda.toBase58()}\n`)

console.log('[setup] mint test USDC; a noise trader creates a MISPRICED market...')
const noise = Keypair.generate()
await send([SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: noise.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })], [agent], 'fund-noise')
const mint = await createMint(conn, agent, agent.publicKey, null, 6, Keypair.generate(), { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID)
const agentAta = (await getOrCreateAssociatedTokenAccount(conn, agent, mint, agent.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID)).address
const noiseAta = (await getOrCreateAssociatedTokenAccount(conn, agent, mint, noise.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID)).address
await mintTo(conn, agent, mint, agentAta, agent, 1000_000000, [], { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID)
await mintTo(conn, agent, mint, noiseAta, agent, 1000_000000, [], { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID)
const vault = getAssociatedTokenAddressSync(mint, vaultAuth, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)

await send([new TransactionInstruction({
  programId: PROGRAM, data: cat(disc('create_market'), u64(MARKET_FIXTURE_ID), cat(Buffer.from([0]), u16(0), u16(1)), agent.publicKey.toBuffer()),
  keys: [
    { pubkey: agent.publicKey, isSigner: true, isWritable: true },
    { pubkey: marketPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
})], [agent], 'create_market')
await send([depositIx('deposit_no', noise, noiseAta, mint, vault, 80_000000)], [noise], 'noise deposit_no 80')
await send([depositIx('deposit_yes', noise, noiseAta, mint, vault, 20_000000)], [noise], 'noise deposit_yes 20')

console.log('\n[agent] ingesting TxLINE odds and autonomously correcting the market...\n')
const decisions = []
for (let i = 1; i <= 6; i++) {
  const { fair, book, live } = await fairHomeProb()
  const m = await marketState()
  const edge = fair - m.priceYes
  const src = live ? 'LIVE' : 'last-seen'
  const line = `round ${i}: TxLINE fair P(${HOME})=${(fair*100).toFixed(1)}% [${book} ${src}] | market YES=${(m.priceYes*100).toFixed(1)}% (${m.yes/1e6}/${m.no/1e6}) | edge ${edge>=0?'+':''}${(edge*100).toFixed(1)}%`
  if (Math.abs(edge) <= EDGE_THRESHOLD) {
    console.log(`${line} -> HOLD (|edge| <= ${EDGE_THRESHOLD*100}%, market efficient)`)
    decisions.push({ round: i, fair, marketYes: m.priceYes, edge, action: 'HOLD' }); break
  }
  const side = edge > 0 ? 'deposit_yes' : 'deposit_no'
  const amount = Math.min(MAX_BET, Math.round(Math.abs(edge) * 100_000000))
  console.log(`${line} -> BUY ${side === 'deposit_yes' ? HOME : AWAY} ${(amount/1e6).toFixed(1)} USDC`)
  await send([depositIx(side, agent, agentAta, mint, vault, amount)], [agent], side)
  decisions.push({ round: i, fair, marketYes: m.priceYes, edge, action: side, amount })
}
const fin = await marketState()
console.log(`\n[done] final market YES = ${(fin.priceYes*100).toFixed(1)}% (${fin.yes/1e6}/${fin.no/1e6}) — converged toward TxLINE fair value`)
console.log(`market ${marketPda.toBase58()} · mint ${mint.toBase58()}`)
fs.writeFileSync(process.env.OUT || '/tmp/ft-agent.json', JSON.stringify({ oddsFixture: ODDS_FIXTURE, market: marketPda.toBase58(), mint: mint.toBase58(), decisions, final: fin }, null, 2))

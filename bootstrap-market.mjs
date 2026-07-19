// Creates an independently funded devnet market for the persistent daemon.
// This script is intentionally separate: the operator supplies liquidity, while
// EDGEBOT_KEYPAIR is the only wallet the daemon will use for trading/settlement.
//
// FIXTURE=... OPERATOR_KEYPAIR=... EDGEBOT_KEYPAIR=... npm run market:bootstrap
import { createHash } from 'crypto'
import fs from 'fs'
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createMint,
  getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo,
} from '@solana/spl-token'

const RPC = process.env.RPC || 'https://api.devnet.solana.com'
const PROGRAM = new PublicKey(process.env.PROGRAM || 'AfvTruVTsrMfqSe5Tgss6hEgYNkk9ADAGKupSQr2DbD8')
const FIXTURE = Number(process.env.FIXTURE)
if (!Number.isSafeInteger(FIXTURE) || FIXTURE <= 0) throw new Error('FIXTURE must be a positive integer')
if (!process.env.OPERATOR_KEYPAIR || !process.env.EDGEBOT_KEYPAIR) throw new Error('OPERATOR_KEYPAIR and EDGEBOT_KEYPAIR are required')
const load = path => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf8'))))
const operator = load(process.env.OPERATOR_KEYPAIR)
const trader = load(process.env.EDGEBOT_KEYPAIR)
if (operator.publicKey.equals(trader.publicKey)) throw new Error('operator and EdgeBot trader must be independent wallets')
const conn = new Connection(RPC, 'confirmed')
const disc = name => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const cat = (...parts) => Buffer.concat(parts)
const [market] = PublicKey.findProgramAddressSync([Buffer.from('market'), u64(FIXTURE)], PROGRAM)
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from('vault'), market.toBuffer()], PROGRAM)
const deposit = PublicKey.findProgramAddressSync([Buffer.from('deposit'), market.toBuffer(), operator.publicKey.toBuffer()], PROGRAM)[0]
if (await conn.getAccountInfo(market)) throw new Error(`fixture ${FIXTURE} already has market ${market.toBase58()}`)

const send = async (instructions, signers, label) => {
  const signature = await sendAndConfirmTransaction(conn, new Transaction().add(...instructions), signers, { commitment: 'confirmed' })
  console.log(`${label}: ${signature}`)
  return signature
}
const mint = await createMint(conn, operator, operator.publicKey, null, 6, Keypair.generate(), { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID)
const operatorToken = (await getOrCreateAssociatedTokenAccount(conn, operator, mint, operator.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID)).address
const traderToken = (await getOrCreateAssociatedTokenAccount(conn, operator, mint, trader.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID)).address
const seedYes = Math.round(Number(process.env.SEED_YES || 100) * 1_000000)
const seedNo = Math.round(Number(process.env.SEED_NO || 200) * 1_000000)
const bankroll = Math.round(Number(process.env.TRADER_BANKROLL || 1000) * 1_000000)
await mintTo(conn, operator, mint, operatorToken, operator, seedYes + seedNo + 100_000000, [], { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID)
await mintTo(conn, operator, mint, traderToken, operator, bankroll, [], { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID)
if (await conn.getBalance(trader.publicKey, 'confirmed') < 0.03 * LAMPORTS_PER_SOL) {
  await send([SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: trader.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })], [operator], 'fund trader gas')
}
const vault = getAssociatedTokenAddressSync(mint, vaultAuth, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
await send([new TransactionInstruction({
  programId: PROGRAM,
  data: cat(disc('create_market'), u64(FIXTURE), Buffer.from([0]), u16(1), u16(2), operator.publicKey.toBuffer()),
  keys: [
    { pubkey: operator.publicKey, isSigner: true, isWritable: true },
    { pubkey: market, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
})], [operator], 'create market')

function depositIx(side, amount) {
  return new TransactionInstruction({
    programId: PROGRAM,
    data: cat(disc(side === 'YES' ? 'deposit_yes' : 'deposit_no'), u64(amount)),
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: operator.publicKey, isSigner: true, isWritable: true },
      { pubkey: deposit, isSigner: false, isWritable: true },
      { pubkey: operatorToken, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vaultAuth, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  })
}
if (seedYes > 0) await send([depositIx('YES', seedYes)], [operator], `seed YES ${seedYes / 1_000000}`)
if (seedNo > 0) await send([depositIx('NO', seedNo)], [operator], `seed NO ${seedNo / 1_000000}`)

const output = {
  fixtureId: FIXTURE,
  market: market.toBase58(),
  mint: mint.toBase58(),
  operator: operator.publicKey.toBase58(),
  trader: trader.publicKey.toBase58(),
  pools: { yes: seedYes, no: seedNo },
  traderBankroll: bankroll,
  createdAt: new Date().toISOString(),
}
const out = process.env.MARKET_BOOTSTRAP_OUT || '/tmp/edgebot-market.json'
fs.writeFileSync(out, JSON.stringify(output, null, 2))
console.log(`\nMarket ready. Start the daemon with:`)
console.log(`FIXTURE=${FIXTURE} MINT=${mint.toBase58()} EXECUTION=onchain CREDS=<path> EDGEBOT_KEYPAIR=<path> npm run daemon`)
console.log(`public receipt: ${out}`)

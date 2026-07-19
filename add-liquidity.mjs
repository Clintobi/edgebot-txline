// Adds operator-owned counterparty liquidity to an existing bootstrap market.
// FIXTURE=... MINT=... OPERATOR_KEYPAIR=... SIDE=NO AMOUNT=100 npm run market:liquidity
import { createHash } from 'crypto'
import fs from 'fs'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'

const RPC = process.env.RPC || 'https://api.devnet.solana.com'
const PROGRAM = new PublicKey(process.env.PROGRAM || 'AfvTruVTsrMfqSe5Tgss6hEgYNkk9ADAGKupSQr2DbD8')
const FIXTURE = Number(process.env.FIXTURE)
const SIDE = String(process.env.SIDE || '').toUpperCase()
const amount = Math.round(Number(process.env.AMOUNT) * 1_000000)
if (!Number.isSafeInteger(FIXTURE) || !['YES', 'NO'].includes(SIDE) || !(amount > 0)) throw new Error('FIXTURE, SIDE=YES|NO, and positive AMOUNT are required')
if (!process.env.OPERATOR_KEYPAIR || !process.env.MINT) throw new Error('OPERATOR_KEYPAIR and MINT are required')
const operator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.OPERATOR_KEYPAIR, 'utf8'))))
const mint = new PublicKey(process.env.MINT)
const conn = new Connection(RPC, 'confirmed')
const disc = name => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
const [market] = PublicKey.findProgramAddressSync([Buffer.from('market'), u64(FIXTURE)], PROGRAM)
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from('vault'), market.toBuffer()], PROGRAM)
const deposit = PublicKey.findProgramAddressSync([Buffer.from('deposit'), market.toBuffer(), operator.publicKey.toBuffer()], PROGRAM)[0]
const operatorToken = getAssociatedTokenAddressSync(mint, operator.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
const vault = getAssociatedTokenAddressSync(mint, vaultAuth, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
const info = await conn.getAccountInfo(market)
if (!info) throw new Error(`market ${market.toBase58()} does not exist`)
if (info.data[85] === 1) throw new Error('market is already settled')
const ix = new TransactionInstruction({
  programId: PROGRAM,
  data: Buffer.concat([disc(SIDE === 'YES' ? 'deposit_yes' : 'deposit_no'), u64(amount)]),
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
const signature = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [operator], { commitment: 'confirmed' })
console.log(JSON.stringify({ fixtureId: FIXTURE, market: market.toBase58(), side: SIDE, amount, signature }))

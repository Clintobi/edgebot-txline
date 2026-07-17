// Get a TxLINE API token: on-chain subscribe (free World Cup tier) -> activate.
// Run: DEPLOYER_KEYPAIR=/path/to/deployer.json node txline-subscribe.mjs
import * as anchor from '@coral-xyz/anchor'
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from '@solana/spl-token'
import { PublicKey, SystemProgram, Keypair, Connection, Transaction } from '@solana/web3.js'
import fs from 'fs'
import nacl from 'tweetnacl'
import axios from 'axios'

const RPC = 'https://api.devnet.solana.com'
const API = 'https://txline-dev.txodds.com'
const TXLINE_PROGRAM = new PublicKey('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J')
const TXL_MINT = new PublicKey('4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG')

const secret = JSON.parse(fs.readFileSync(process.env.DEPLOYER_KEYPAIR, 'utf8'))
const kp = Keypair.fromSecretKey(Uint8Array.from(secret))
const connection = new Connection(RPC, 'confirmed')
const wallet = new anchor.Wallet(kp)
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' })
anchor.setProvider(provider)
console.log('Wallet:', kp.publicKey.toBase58())

const log = (...a) => console.log(...a)

// 1) IDL
log('\n[1] Fetching TxLINE IDL...')
const idl = await anchor.Program.fetchIdl(TXLINE_PROGRAM, provider)
if (!idl) { console.error('❌ No on-chain IDL for TxLINE program — cannot use Anchor abstraction.'); process.exit(2) }
const program = new anchor.Program(idl, provider)
const sub = idl.instructions.find(i => i.name === 'subscribe' || i.name === 'Subscribe')
log('   IDL name:', idl.metadata?.name || idl.name, '| instructions:', idl.instructions.map(i=>i.name).join(', '))
if (sub) log('   subscribe args:', JSON.stringify(sub.args), '\n   subscribe accounts:', sub.accounts.map(a=>a.name).join(', '))

// 2) PDAs
const [tokenTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from('token_treasury_v2')], TXLINE_PROGRAM)
const [pricingMatrixPda] = PublicKey.findProgramAddressSync([Buffer.from('pricing_matrix')], TXLINE_PROGRAM)
const tokenTreasuryVault = getAssociatedTokenAddressSync(TXL_MINT, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
const userTokenAccount = getAssociatedTokenAddressSync(TXL_MINT, kp.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
log('\n[2] PDAs:\n   treasuryPda:', tokenTreasuryPda.toBase58(), '\n   pricingMatrix:', pricingMatrixPda.toBase58(), '\n   userTXLata:', userTokenAccount.toBase58())

// 3) Ensure user TXL ATA exists
log('\n[3] Checking user TXL token account...')
let haveAta = false
try { const acc = await getAccount(connection, userTokenAccount, 'confirmed', TOKEN_2022_PROGRAM_ID); haveAta = true; log('   exists, balance:', acc.amount.toString()) }
catch { log('   missing — creating...') }
if (!haveAta) {
  const ix = createAssociatedTokenAccountInstruction(kp.publicKey, userTokenAccount, kp.publicKey, TXL_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
  const tx = new Transaction().add(ix)
  const sig = await provider.sendAndConfirm(tx, [])
  log('   created ATA, tx:', sig)
}

// 4) Subscribe (serviceLevel=1 free, weeks=4)
log('\n[4] Subscribing (serviceLevel=1, weeks=4)...')
let txSig
try {
  txSig = await program.methods.subscribe(1, 4).accounts({
    user: kp.publicKey,
    pricingMatrix: pricingMatrixPda,
    tokenMint: TXL_MINT,
    userTokenAccount,
    tokenTreasuryVault,
    tokenTreasuryPda,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).rpc()
  log('   ✅ subscribe tx:', txSig)
} catch (e) {
  console.error('   ❌ subscribe failed:', e.message || e)
  if (e.logs) console.error('   logs:', e.logs.slice(-8).join('\n          '))
  process.exit(3)
}

// 5) Activate API token
log('\n[5] Activating API token...')
const jwt = (await axios.post(`${API}/auth/guest/start`)).data.token
const message = new TextEncoder().encode(`${txSig}::${jwt}`)
const walletSig = Buffer.from(nacl.sign.detached(message, kp.secretKey)).toString('base64')
try {
  const res = await axios.post(`${API}/api/token/activate`, { txSig, walletSignature: walletSig, leagues: [] }, { headers: { Authorization: `Bearer ${jwt}` } })
  const apiToken = res.data.token || res.data.apiToken || res.data
  log('   ✅ API Token:', typeof apiToken === 'string' ? apiToken : JSON.stringify(apiToken))
  fs.writeFileSync(process.env.OUT || '/tmp/txline-creds.json', JSON.stringify({ jwt, apiToken, subscribeTx: txSig, wallet: kp.publicKey.toBase58() }, null, 2))
  log('\n✅ Saved creds to', process.env.OUT || '/tmp/txline-creds.json')
} catch (e) {
  console.error('   ❌ activate failed:', e.response?.status, JSON.stringify(e.response?.data) || e.message)
  process.exit(4)
}

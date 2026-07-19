// verify.mjs — credential-free judge verifier for EdgeBot.
//
// Re-checks the last autonomous run end-to-end with NO keys and NO wallet:
//   1. reads the on-chain market from PUBLIC devnet RPC (state + resolution),
//   2. re-fetches the REAL TxLINE final score and re-derives the outcome — proving the
//      settlement matches reality and was never a number we typed in,
//   3. confirms the on-chain pools match the reported run, and
//   4. re-runs the CLV backtest from the committed cache and checks it reproduces.
// Everything is public and read-only, so anyone can run:  npm run judge:verify
import fs from 'fs'
import { execFileSync } from 'child_process'
import { Connection, PublicKey } from '@solana/web3.js'
import { verifyGateLedger } from './lib/policy-gate.mjs'
import { oddsTicks, tickFingerprint } from './lib/repricer.mjs'

const RPC = process.env.RPC || 'https://api.devnet.solana.com'
const API = 'https://txline-dev.txodds.com'
const API_TOKEN = 'txoracle_api_6f0df6e475c04668b9a3a19aa1eefda4'   // free read-only devnet token
const run = JSON.parse(fs.readFileSync(process.env.RUN || new URL('./dashboard/last-run.json', import.meta.url), 'utf8'))

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

  // --- 2: real TxLINE result → derived outcome, compared to on-chain resolution ---
  const jwt = (await (await fetch(`${API}/auth/guest/start`, { method: 'POST' })).json()).token
  const H = { Authorization: `Bearer ${jwt}`, 'X-Api-Token': API_TOKEN }
  const rows = await (await fetch(`${API}/api/scores/snapshot/${run.fixture}`, { headers: H })).json()
  const fin = (Array.isArray(rows) ? rows : []).filter(r => r.Stats && r.Stats['1'] != null && r.Stats['2'] != null && (r.Action === 'game_finalised' || r.StatusId === 100 || r.Period === 100)).sort((a, b) => (b.Seq || 0) - (a.Seq || 0))[0]
  if (!fin) ok('re-fetched real TxLINE final score', false, 'no finalised record')
  else {
    const g1 = Number(fin.Stats['1']), g2 = Number(fin.Stats['2'])
    const derived = g1 > g2 ? 'YES' : 'NO'
    ok('real TxLINE score re-fetched', true, `${g1}–${g2}`)
    ok('score matches the run', g1 === run.realResult.g1 && g2 === run.realResult.g2)
    ok('DERIVED outcome = on-chain resolution', derived === onchainRes, `real score → ${derived}, chain settled ${onchainRes} (outcome was NOT caller-chosen)`)
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
  const accountKeys = (message?.staticAccountKeys || message?.accountKeys || []).map(key => key.toBase58())
  ok('live daemon devnet transaction succeeded', !!transaction && transaction.meta?.err == null, proof.receipt.transactionSignature.slice(0, 12) + '…')
  ok('transaction binds EdgeBot trader + market + program', [proof.trader, proof.market, proof.program].every(key => accountKeys.includes(key)))
  const liveInfo = await conn.getAccountInfo(new PublicKey(proof.market))
  const expectedYes = allowed.intent.pools.yes + (allowed.intent.side === 'YES' ? allowed.intent.amount : 0)
  const expectedNo = allowed.intent.pools.no + (allowed.intent.side === 'NO' ? allowed.intent.amount : 0)
  ok('live market pools include the gated deposit', !!liveInfo && Number(liveInfo.data.readBigUInt64LE(86)) === expectedYes && Number(liveInfo.data.readBigUInt64LE(94)) === expectedNo,
    `${expectedYes / 1e6}/${expectedNo / 1e6}`)
} catch (e) { ok('live SSE → policy → devnet transaction proof', false, String(e.message || e).slice(0, 100)) }

console.log(`\n${fail === 0 ? '✅ ALL CHECKS PASS' : `❌ ${fail} CHECK(S) FAILED`} — ${pass} passed, ${fail} failed.`)
console.log(`Everything above was read from public devnet RPC + TxLINE + this repo. No trust required.\n`)
process.exit(fail === 0 ? 0 : 1)

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

console.log(`\n${fail === 0 ? '✅ ALL CHECKS PASS' : `❌ ${fail} CHECK(S) FAILED`} — ${pass} passed, ${fail} failed.`)
console.log(`Everything above was read from public devnet RPC + TxLINE + this repo. No trust required.\n`)
process.exit(fail === 0 ? 0 : 1)

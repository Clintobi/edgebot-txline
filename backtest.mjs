// backtest.mjs — Closing-Line-Value (CLV) backtest for EdgeBot.
//
// EdgeBot's edge claim: TxLINE's demargined 1X2 book is a sharp probability, and
// acting on its early read captures value versus the market's efficient CLOSING line.
// CLV is the professional edge metric — it measures skill independent of short-run
// luck: if your entries systematically beat the close, your signal is +EV.
//
// Market framing = EdgeBot's actual on-chain market: YES = home wins outright,
// NO = draw or away. Fair P(YES) = raw home 1X2 prob (draw stays in NO).
//
// For each finished fixture we take the pre-kickoff demargined tick series, decide a
// side at an ENTRY tick using ONLY pre-entry data, then grade:
//   (a) CLV  = closing implied prob(backed side) - entry implied prob(backed side)
//   (b) hit  = did the backed side actually win
// We sweep three transparent strategies (follow-steam / fade / back-favorite) and
// report N, beat-the-close rate, mean CLV, hit rate, and a t-stat. We also report the
// Brier score of the closing line vs results, to show how sharp the book itself is.
//
//   CREDS=txline-creds.json node backtest.mjs            (uses the built-in universe)
//   FIXTURES=1,2,3 ENTRY_FRAC=0.5 node backtest.mjs
import fs from 'fs'
import { clvGrade } from './lib.mjs'
const API = 'https://txline-dev.txodds.com'
const creds = JSON.parse(fs.readFileSync(process.env.CREDS || '/Users/mac/fulltime-keys/txline-creds.json', 'utf8'))
const apiToken = typeof creds.apiToken === 'string' ? creds.apiToken : creds.apiToken.token
const ENTRY_FRAC = Number(process.env.ENTRY_FRAC || 0.5)   // where in the pre-KO window EdgeBot enters
const TEAM = { 1144:'India',1215:'Myanmar',1225:'New Zealand',1378:'Vietnam',1489:'Argentina',1519:'Australia',1634:'Brazil',1888:'England',1999:'France',2431:'Liechtenstein',3021:'Spain',45856:'Gibraltar' }
const nm = id => TEAM[id] || `#${id}`

// Read the pre-built pre-KO 1X2 tick cache (fetch-odds-cache.mjs). Keyed by fixture id.
const CACHE = JSON.parse(fs.readFileSync(process.env.CACHE || new URL('./odds-cache.json', import.meta.url), 'utf8'))
const wanted = process.env.FIXTURES ? process.env.FIXTURES.split(',') : Object.keys(CACHE)
function loadFixture(fid) {
  const c = CACHE[fid]
  if (!c || !Array.isArray(c.ticks) || c.ticks.length < 4) return null
  const pre = [...c.ticks].sort((a, b) => a.ts - b.ts)
  return { fid: Number(fid), g1: c.g1, g2: c.g2, home: nm(c.p1), away: nm(c.p2), pre }
}

// a bet = { side:'YES'|'NO', clv, clvPct } — CLV computed by the unit-tested lib
const grade = (side, entry, close) => ({ side, ...clvGrade(side, entry.pYes, close.pYes) })
function decide(strategy, open, entry) {
  const drift = entry.pYes - open.pYes    // open->entry movement in P(home win)
  if (strategy === 'steam') return Math.abs(drift) < 1e-9 ? null : (drift > 0 ? 'YES' : 'NO')
  if (strategy === 'fade')  return Math.abs(drift) < 1e-9 ? null : (drift > 0 ? 'NO' : 'YES')
  if (strategy === 'fav')   return entry.pYes >= 0.5 ? 'YES' : 'NO'
  return null
}

const STRATS = ['steam', 'fade', 'fav']
const loaded = wanted.map(loadFixture).filter(Boolean)
process.stderr.write(`${loaded.length} fixtures had a usable pre-KO 1X2 series\n`)
const rows = []
for (const f of loaded) {
  const open = f.pre[0], close = f.pre[f.pre.length - 1]
  const entry = f.pre[Math.max(1, Math.min(f.pre.length - 2, Math.floor(ENTRY_FRAC * (f.pre.length - 1))))]
  const yesWon = f.g1 > f.g2
  const rec = { fid: f.fid, match: `${f.home} ${f.g1}-${f.g2} ${f.away}`, yesWon, ticks: f.pre.length, t0: open.ts,
    openYes: open.pYes, entryYes: entry.pYes, closeYes: close.pYes, bets: {} }
  for (const s of STRATS) {
    const side = decide(s, open, entry)
    if (!side) continue
    const g = grade(side, entry, close)
    const won = side === 'YES' ? yesWon : !yesWon
    rec.bets[s] = { ...g, won }
  }
  rows.push(rec)
}
rows.sort((a, b) => a.t0 - b.t0)   // chronological order, so the walk-forward is causal

// ---- reproducible (seeded) statistics ----
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
const BOOT = Number(process.env.BOOT || 10000)
function ci95(values) {                                  // seeded bootstrap 95% CI on the mean
  if (values.length < 2) return { lo: NaN, hi: NaN }
  const rng = mulberry32(0x9e3779b9), n = values.length, means = []
  for (let i = 0; i < BOOT; i++) { let s = 0; for (let j = 0; j < n; j++) s += values[Math.floor(rng() * n)]; means.push(s / n) }
  means.sort((a, b) => a - b)
  return { lo: means[Math.floor(0.025 * BOOT)], hi: means[Math.floor(0.975 * BOOT)] }
}
function stats(clvs) {
  const n = clvs.length, mean = clvs.reduce((a, x) => a + x, 0) / n
  const sd = Math.sqrt(clvs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n - 1))
  return { n, mean, sd, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, ci: ci95(clvs), beat: clvs.filter(x => x > 0).length / n }
}
function summarize(strat) {
  const bets = rows.map(r => r.bets[strat]).filter(Boolean)
  if (!bets.length) return null
  return { ...stats(bets.map(b => b.clv)), hit: bets.filter(b => b.won).length / bets.length, meanClvPct: bets.reduce((a, b) => a + b.clvPct, 0) / bets.length }
}

// ---- walk-forward: choose the strategy on the in-sample PREFIX, grade OUT of sample ----
function walkForward(folds = 4) {
  const N = rows.length, per = Math.ceil(N / folds), oos = []
  for (let k = 1; k < folds; k++) {
    const inSample = rows.slice(0, k * per), outSample = rows.slice(k * per, (k + 1) * per)
    if (!outSample.length) break
    let best = null, bestMean = -Infinity
    for (const st of STRATS) {
      const c = inSample.map(r => r.bets[st]).filter(Boolean).map(b => b.clv)
      if (c.length) { const m = c.reduce((a, x) => a + x, 0) / c.length; if (m > bestMean) { bestMean = m; best = st } }
    }
    for (const r of outSample) { const b = r.bets[best]; if (b) oos.push({ ...b, strat: best, fid: r.fid }) }
  }
  if (!oos.length) return null
  return { ...stats(oos.map(o => o.clv)), hit: oos.filter(o => o.won).length / oos.length, meanClvPct: oos.reduce((a, o) => a + o.clvPct, 0) / oos.length, bets: oos }
}

// ---- calibration / reliability of the closing line ----
function calibration(bins = 5) {
  const out = []
  for (let i = 0; i < bins; i++) {
    const lo = i / bins, hi = (i + 1) / bins
    const b = rows.filter(r => r.closeYes >= lo && (i === bins - 1 ? r.closeYes <= hi : r.closeYes < hi))
    out.push(b.length ? { lo, hi, n: b.length, pred: b.reduce((a, r) => a + r.closeYes, 0) / b.length, actual: b.filter(r => r.yesWon).length / b.length } : { lo, hi, n: 0 })
  }
  return out
}

// book sharpness: Brier of the closing home-win prob vs outcome, vs a base-rate baseline
const closeProbs = rows.map(r => ({ p: r.closeYes, y: r.yesWon ? 1 : 0 }))
const brier = closeProbs.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / closeProbs.length
const base = closeProbs.reduce((a, x) => a + x.y, 0) / closeProbs.length
const brierBase = closeProbs.reduce((a, x) => a + (base - x.y) ** 2, 0) / closeProbs.length

const wf = walkForward()
const cal = calibration()
const pp = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + 'pp'

console.log(`\nEdgeBot CLV backtest — ${rows.length} finished fixtures · entry at ${Math.round(ENTRY_FRAC*100)}% of the pre-KO window · seeded bootstrap ${BOOT}×\n`)

console.log('1) BOOK SHARPNESS — is the demargined closing line a well-calibrated probability?')
console.log(`   closing-line Brier ${brier.toFixed(3)} vs ${brierBase.toFixed(3)} base rate → ${brier < brierBase ? 'sharper than base rate ✓' : 'no edge over base rate'}`)
console.log('   reliability (closing P(YES) bin → predicted vs actual win rate):')
for (const c of cal) if (c.n) console.log(`     ${(c.lo*100).toFixed(0).padStart(3)}–${(c.hi*100).toFixed(0)}%   n=${String(c.n).padStart(2)}   predicted ${(c.pred*100).toFixed(0).padStart(3)}%   actual ${(c.actual*100).toFixed(0).padStart(3)}%`)

console.log('\n2) IN-SAMPLE strategy sweep (transparency — this is the cherry-pickable number):')
console.log('   strategy   N   beat-close   mean CLV%   95% bootstrap CI       hit')
for (const s of STRATS) { const z = summarize(s); if (!z) continue
  console.log(`   ${s.padEnd(8)}  ${String(z.n).padStart(2)}   ${(z.beat*100).toFixed(0).padStart(3)}%       ${(z.meanClvPct>=0?'+':'')+z.meanClvPct.toFixed(2)}%    [${pp(z.ci.lo)}, ${pp(z.ci.hi)}]${z.ci.lo>0?' *sig':''}    ${(z.hit*100).toFixed(0)}%`) }

console.log('\n3) WALK-FORWARD — THE HONEST TEST (strategy chosen on the past, graded on the future):')
if (wf) {
  console.log(`   out-of-sample: N=${wf.n} · beat-close ${(wf.beat*100).toFixed(0)}% · mean CLV ${(wf.meanClvPct>=0?'+':'')+wf.meanClvPct.toFixed(2)}% (${pp(wf.mean)}) · hit ${(wf.hit*100).toFixed(0)}% · t=${wf.t>=0?'+':''}${wf.t.toFixed(2)}`)
  console.log(`   95% bootstrap CI on OOS mean CLV: [${pp(wf.ci.lo)}, ${pp(wf.ci.hi)}] → ${wf.ci.lo > 0 ? 'EXCLUDES zero (significant +CLV)' : 'includes zero (directional, not yet significant)'}`)
} else console.log('   (not enough fixtures for a walk-forward split)')

console.log(`\nHONEST READ: with N=${rows.length} the CLV interval ${wf && wf.ci.lo > 0 ? 'clears' : 'still spans'} zero — the rigor (seeded bootstrap CI + walk-forward + calibration) is the point, and it scales to the full fixture history. Book sharpness is the robust result; walk-forward CLV is the forward-looking, non-cherry-picked one.`)

fs.writeFileSync(process.env.OUT || '/tmp/edgebot-backtest.json', JSON.stringify({ entryFrac: ENTRY_FRAC, boot: BOOT, n: rows.length, brier, brierBase, calibration: cal, sweep: Object.fromEntries(STRATS.map(s => [s, summarize(s)])), walkForward: wf, rows }, null, 2))

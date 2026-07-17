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

// a bet = { side:'YES'|'NO', entryImplied, closeImplied }
function grade(side, entry, close) {
  const eImp = side === 'YES' ? entry.pYes : 1 - entry.pYes
  const cImp = side === 'YES' ? close.pYes : 1 - close.pYes
  const clv = cImp - eImp                 // >0 => closing line moved our way (beat the close)
  return { side, eImp, cImp, clv, clvPct: (clv / eImp) * 100 }
}
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
  const rec = { fid: f.fid, match: `${f.home} ${f.g1}-${f.g2} ${f.away}`, yesWon, ticks: f.pre.length,
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

function summarize(strat) {
  const bets = rows.map(r => r.bets[strat]).filter(Boolean)
  const n = bets.length
  if (!n) return null
  const clvs = bets.map(b => b.clv)
  const mean = clvs.reduce((a, x) => a + x, 0) / n
  const sd = Math.sqrt(clvs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n - 1))
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0
  const beat = bets.filter(b => b.clv > 0).length / n
  const hit = bets.filter(b => b.won).length / n
  const meanPct = bets.reduce((a, b) => a + b.clvPct, 0) / n
  return { n, beat, meanClvPts: mean, meanClvPct: meanPct, hit, t }
}

// book sharpness: Brier of the closing home-win prob vs outcome, vs a base-rate baseline
const closeProbs = rows.map(r => ({ p: r.closeYes, y: r.yesWon ? 1 : 0 }))
const brier = closeProbs.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / closeProbs.length
const base = closeProbs.reduce((a, x) => a + x.y, 0) / closeProbs.length
const brierBase = closeProbs.reduce((a, x) => a + (base - x.y) ** 2, 0) / closeProbs.length

console.log(`\nEdgeBot CLV backtest — ${rows.length} finished fixtures, entry at ${Math.round(ENTRY_FRAC*100)}% of the pre-kickoff window\n`)
console.log('per-fixture (steam strategy):')
console.log('  match                                   ticks  open→entry→close P(YES)   bet   CLV%    result')
for (const r of rows) {
  const b = r.bets.steam
  console.log(`  ${r.match.padEnd(38).slice(0,38)}  ${String(r.ticks).padStart(4)}   ${(r.openYes*100).toFixed(0).padStart(3)}→${(r.entryYes*100).toFixed(0).padStart(3)}→${(r.closeYes*100).toFixed(0).padStart(3)}%   ${b?b.side.padEnd(3):' - '}  ${b?(b.clvPct>=0?'+':'')+b.clvPct.toFixed(1):'   '}   ${r.yesWon?'YES won':'NO won'}${b?(b.won?'  ✓':'  ✗'):''}`)
}
console.log('\nstrategy sweep (CLV = did our entry beat the closing line):')
console.log('  strategy   N   beat-close   mean CLV%   mean CLV(pts)   hit-rate   t-stat')
for (const s of STRATS) {
  const z = summarize(s); if (!z) continue
  console.log(`  ${s.padEnd(8)}  ${String(z.n).padStart(2)}   ${(z.beat*100).toFixed(0).padStart(3)}%        ${(z.meanClvPct>=0?'+':'')+z.meanClvPct.toFixed(2)}%      ${(z.meanClvPts>=0?'+':'')+(z.meanClvPts*100).toFixed(2)}pp        ${(z.hit*100).toFixed(0).padStart(3)}%      ${z.t>=0?'+':''}${z.t.toFixed(2)}`)
}
console.log(`\nbook sharpness: closing-line Brier = ${brier.toFixed(3)} vs base-rate ${brierBase.toFixed(3)}  (lower = sharper; ${brier<brierBase?'the demargined close beats the base rate':'no edge over base rate'})`)
console.log(`\nnote: N is limited by finished fixtures available on this devnet feed; the harness scales to the full fixture history. CLV, not short-run P&L, is the edge metric.`)

fs.writeFileSync(process.env.OUT || '/tmp/edgebot-backtest.json', JSON.stringify({ entryFrac: ENTRY_FRAC, rows, summary: Object.fromEntries(STRATS.map(s => [s, summarize(s)])), brier, brierBase }, null, 2))

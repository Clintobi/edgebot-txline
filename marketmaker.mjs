// marketmaker.mjs — backtests EdgeBot's market-making DESIGN on real TxLINE line
// movement, and DECOMPOSES the P&L honestly into gross spread captured vs adverse
// selection. It is cache-only (no creds), seeded (reproducible), and — importantly
// — the taker flow is a SYNTHETIC model, not real order flow. This is presented as
// a market-making design with an honest cost decomposition, NOT a profit claim.
//
//   node marketmaker.mjs                 # default synthetic flow (pInformed=0.4)
//   P_INFORMED=0.6 LAMBDA=3 node marketmaker.mjs
//
// Per fixture: walk the pre-KO demargined fair-value ticks; the MM re-quotes both
// sides around fair (inventory-skewed, variance-widened); synthetic takers arrive
// each tick (NOISE flow + INFORMED flow that marks against the maker, a la
// Glosten–Milgrom adverse selection); at full time the
// inventory settles at the real 0/1 outcome. Accounting relative to transacting at
// fair splits total P&L into: gross spread (always +) and inventory/adverse-selection.
import fs from 'fs'
import { quote, tickVariance } from './lib/mm.mjs'

const CACHE = JSON.parse(fs.readFileSync(new URL('./odds-cache.json', import.meta.url), 'utf8'))
const P_INFORMED = Number(process.env.P_INFORMED ?? 0.4)   // fraction of taker flow that is sharp/informed
const LAMBDA = Number(process.env.LAMBDA ?? 2)             // expected takers per tick
const SIZE = 1                                             // one unit per taker fill
const mulberry32 = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }

function runFixture(fid, c, seed) {
  // Separate streams so P_INFORMED changes ONLY the informed/noise mix, never the
  // arrival count — otherwise gross spread would spuriously move with the flow mix.
  const rngArr = mulberry32(seed), rngFlow = mulberry32(seed ^ 0x5bd1e995)
  const ticks = [...c.ticks].sort((a, b) => a.ts - b.ts)
  if (ticks.length < 4) return null
  const outcome = c.g1 > c.g2 ? 1 : 0            // YES = home wins outright
  let inv = 0        // net YES inventory held by the MM (+ = long YES)
  let cash = 0       // realized cash from fills
  let grossSpread = 0, fills = 0                 // grossSpread = half-spread earned over the MM's own mid
  const window = []
  for (let i = 0; i < ticks.length; i++) {
    const fair = ticks[i].pYes
    window.push(fair); if (window.length > 6) window.shift()
    const variance = Math.max(1e-4, tickVariance(window))
    const q = quote(fair, inv, { variance })
    const nTakers = Math.floor(rngArr() * (2 * LAMBDA + 1))   // 0..2λ takers this tick
    for (let k = 0; k < nTakers; k++) {
      const informed = rngFlow() < P_INFORMED, dirRoll = rngFlow()
      // Glosten–Milgrom adverse selection: informed flow transacts toward the true
      // settlement value (buys YES if YES settles 1, sells if 0), so it systematically
      // marks against the maker. Noise flow is 50/50. Real flow is only PARTIALLY
      // informed, so this is a stress model — not a worst case that must obtain.
      const buysYes = informed ? outcome === 1 : dirRoll < 0.5
      if (buysYes) {            // taker buys YES from MM at ask -> MM goes short YES
        inv -= SIZE; cash += q.ask * SIZE; grossSpread += q.halfSpread * SIZE
      } else {                  // taker sells YES to MM at bid -> MM goes long YES
        inv += SIZE; cash -= q.bid * SIZE; grossSpread += q.halfSpread * SIZE
      }
      fills++
    }
  }
  const netPnl = cash + inv * outcome                 // settle inventory at the real result
  const inventoryPnl = netPnl - grossSpread           // residual: inventory marked (own mid -> outcome) = adverse selection + inventory risk
  return { fid: Number(fid), fills, endInv: inv, grossSpread, inventoryPnl, netPnl, outcome }
}

const rows = []
for (const fid of Object.keys(CACHE)) {
  const r = runFixture(fid, CACHE[fid], 0x9e3779b9 ^ Number(fid))
  if (r) rows.push(r)
}
const sum = k => rows.reduce((a, r) => a + r[k], 0)
const n = rows.length, fills = sum('fills')
const gross = sum('grossSpread'), invPnl = sum('inventoryPnl'), net = sum('netPnl')
const winRows = rows.filter(r => r.netPnl > 0).length

console.log(`\nEdgeBot market-making DESIGN — backtest on ${n} real fixtures`)
console.log(`taker-flow model (SYNTHETIC): λ=${LAMBDA}/tick, P(informed)=${P_INFORMED} · seeded, reproducible\n`)
console.log(`  fills (both sides)        ${fills}`)
console.log(`  gross spread captured    ${gross >= 0 ? '+' : ''}${gross.toFixed(2)} units   (always positive — the maker's income)`)
console.log(`  adverse selection / inv  ${invPnl >= 0 ? '+' : ''}${invPnl.toFixed(2)} units   (informed flow marking against us)`)
console.log(`  ───────────────────────  `)
console.log(`  net P&L                  ${net >= 0 ? '+' : ''}${net.toFixed(2)} units   (${winRows}/${n} fixtures net-positive)\n`)
console.log(`HONEST READ: the spread is real income; whether the MM is net-positive depends entirely on the`)
console.log(`flow mix. Raise P_INFORMED and net P&L falls as adverse selection eats the spread — the classic`)
console.log(`market-maker tension. The taker flow here is a MODEL, not observed order flow, so this is a`)
console.log(`design + cost decomposition, not evidence that the MM prints. Real flow is the open question.\n`)

fs.writeFileSync(process.env.OUT || '/tmp/edgebot-mm.json', JSON.stringify({ pInformed: P_INFORMED, lambda: LAMBDA, n, fills, gross, invPnl, net, rows }, null, 2))

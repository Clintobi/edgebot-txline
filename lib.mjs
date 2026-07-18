// lib.mjs — EdgeBot's pure quant primitives, isolated so they're unit-testable.
// backtest.mjs imports clvGrade from here; agent.mjs uses the identical formulas
// (rawFairProb, fractionalKelly, deriveOutcome). Tested in test/lib.test.mjs.

// Fair P(YES) for a "home wins outright" market. YES = home win; a DRAW belongs in NO,
// so we take the RAW 1X2 home probability — never renormalize to two-way (that double-
// counts the favourite, e.g. a true 72.5% would balloon to ~90%).
export function rawFairProb(pct) {
  const [p1] = pct.map(Number)
  return p1 / 100
}

// Full Kelly fraction for a binary bet at fair prob p, market-implied price q.
export const kelly = (p, q) => (p - q) / (1 - q)

// Fractional (quarter-)Kelly, floored at 0 so we never stake a negative edge.
export const fractionalKelly = (p, q, frac = 0.25) => Math.max(0, frac * kelly(p, q))

// Closing-line value for a backed side. clv > 0 means the closing line moved our way
// (we got a better price than the close) — the professional edge metric.
export function clvGrade(side, entryPYes, closePYes) {
  const e = side === 'YES' ? entryPYes : 1 - entryPYes
  const c = side === 'YES' ? closePYes : 1 - closePYes
  return { clv: c - e, clvPct: e > 0 ? (c - e) / e * 100 : 0 }
}

// Outcome derived from the real final score. 0 = Yes (home wins outright), 1 = No.
export const deriveOutcome = (g1, g2) => (g1 > g2 ? 0 : 1)

// Brier score of a set of {p: predicted prob, y: 0|1 outcome}. Lower = sharper.
export const brier = (probs) => probs.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / probs.length

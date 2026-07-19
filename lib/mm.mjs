// lib/mm.mjs — EdgeBot market-making core: inventory-aware two-sided quoting.
//
// This is a market-making DESIGN, not a profit claim. Instead of taking one side
// when |edge| > threshold (the deliberately-simple value rule), EdgeBot can quote
// BOTH sides of a match-outcome market anchored to the live TxLINE demargined fair
// probability, and skew those quotes by its current inventory — a simplified
// Avellaneda–Stoikov reservation price — so it leans against building one-sided
// exposure and earns the spread while the sharp closing line does price discovery.
//
// Pure and deterministic, so the quoting logic is unit-testable. The backtest that
// exercises it (with a clearly-synthetic taker-flow model) lives in marketmaker.mjs.

const clamp01 = x => Math.max(1e-4, Math.min(1 - 1e-4, x))

// Reservation price: fair value shifted AWAY from current inventory.
//   inventory > 0 (net long YES)  -> reservation drops -> both quotes drop ->
//   takers are nudged to buy YES off us, reducing the long. gamma = risk aversion,
//   variance = the line's uncertainty (skew harder when the line is noisier).
export function reservationPrice(fair, inventory, { gamma = 0.6, variance = 0.25 } = {}) {
  return clamp01(fair - inventory * gamma * variance)
}

// Two-sided quote around the reservation price. The spread widens with variance:
// a more uncertain line is quoted wider. Returns YES-token prices in (0,1).
//   bid = price the MM PAYS to buy YES from a taker
//   ask = price the MM CHARGES to sell YES to a taker   (ask > bid, always)
export function quote(fair, inventory, opts = {}) {
  const { gamma = 0.6, variance = 0.25, baseSpread = 0.03, spreadK = 0.5 } = opts
  const r = reservationPrice(fair, inventory, { gamma, variance })
  const halfSpread = (baseSpread + spreadK * variance) / 2
  return { reservation: r, halfSpread, bid: clamp01(r - halfSpread), ask: clamp01(r + halfSpread) }
}

// Realized-variance estimate from a short window of fair-value ticks (0..1).
// Used to widen the spread when the line is moving fast. Deterministic.
export function tickVariance(fairs) {
  if (!fairs || fairs.length < 2) return 0
  const d = []
  for (let i = 1; i < fairs.length; i++) d.push(fairs[i] - fairs[i - 1])
  const m = d.reduce((a, x) => a + x, 0) / d.length
  return d.reduce((a, x) => a + (x - m) ** 2, 0) / d.length
}

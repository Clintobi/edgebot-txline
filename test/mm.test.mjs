import { describe, it, expect } from 'vitest'
import { reservationPrice, quote, tickVariance } from '../lib/mm.mjs'

describe('market-maker quoting core', () => {
  it('flat inventory quotes symmetrically around fair', () => {
    const q = quote(0.5, 0, { variance: 0.25 })
    expect(q.reservation).toBeCloseTo(0.5, 6)
    expect(q.bid).toBeLessThan(0.5)
    expect(q.ask).toBeGreaterThan(0.5)
    expect(0.5 - q.bid).toBeCloseTo(q.ask - 0.5, 6)   // symmetric when flat
  })

  it('bid is always strictly below ask (no crossed book)', () => {
    for (const fair of [0.1, 0.4, 0.72, 0.95]) {
      for (const inv of [-8, -1, 0, 1, 8]) {
        const q = quote(fair, inv)
        expect(q.bid).toBeLessThan(q.ask)
      }
    }
  })

  it('long inventory skews the reservation price DOWN (leans against the position)', () => {
    expect(reservationPrice(0.5, 5)).toBeLessThan(0.5)
    expect(reservationPrice(0.5, -5)).toBeGreaterThan(0.5)
    // monotonic in inventory
    expect(reservationPrice(0.5, 5)).toBeLessThan(reservationPrice(0.5, 1))
  })

  it('a noisier line is quoted wider', () => {
    const calm = quote(0.5, 0, { variance: 0.01 })
    const wild = quote(0.5, 0, { variance: 0.4 })
    expect(wild.halfSpread).toBeGreaterThan(calm.halfSpread)
  })

  it('quotes stay inside (0,1) under extreme inventory', () => {
    const q = quote(0.9, 50, { variance: 0.5 })
    expect(q.bid).toBeGreaterThan(0)
    expect(q.ask).toBeLessThan(1)
  })

  it('tickVariance is zero for a flat line and positive for a moving one', () => {
    expect(tickVariance([0.5, 0.5, 0.5])).toBe(0)
    expect(tickVariance([0.4, 0.5, 0.45, 0.6])).toBeGreaterThan(0)
  })
})

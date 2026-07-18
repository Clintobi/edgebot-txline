import { describe, it, expect } from 'vitest'
import { rawFairProb, kelly, fractionalKelly, clvGrade, deriveOutcome, brier } from '../lib.mjs'

describe('rawFairProb — the draw-bug fix', () => {
  it('takes the raw home prob; the draw stays in NO (no two-way renormalization)', () => {
    // 1X2 = 72.5 / 19 / 8.5.  Correct YES prob is 0.725, NOT 72.5/(72.5+8.5)=0.895.
    expect(rawFairProb(['72.5', '19', '8.5'])).toBeCloseTo(0.725, 6)
  })
})

describe('Kelly sizing', () => {
  it('full Kelly f* = (p-q)/(1-q)', () => {
    expect(kelly(0.6, 0.4)).toBeCloseTo((0.6 - 0.4) / (1 - 0.4), 9)
  })
  it('quarter-Kelly is a quarter of full', () => {
    expect(fractionalKelly(0.6, 0.4, 0.25)).toBeCloseTo(0.25 * kelly(0.6, 0.4), 9)
  })
  it('never stakes a negative edge (floored at 0)', () => {
    expect(fractionalKelly(0.4, 0.5)).toBe(0)
  })
})

describe('closing-line value', () => {
  it('YES: positive CLV when the backed side firms into the close', () => {
    expect(clvGrade('YES', 0.50, 0.60).clv).toBeCloseTo(0.10, 9)
  })
  it('NO: implied price inverts (1 - pYes)', () => {
    // NO implied goes 0.50 -> 0.60 as pYes drops 0.50 -> 0.40
    expect(clvGrade('NO', 0.50, 0.40).clv).toBeCloseTo(0.10, 9)
  })
  it('clvPct is relative to the entry price', () => {
    expect(clvGrade('YES', 0.50, 0.60).clvPct).toBeCloseTo(20, 6)
  })
})

describe('outcome derived from the real score (never chosen)', () => {
  it('home win -> YES (0)', () => expect(deriveOutcome(3, 2)).toBe(0))
  it('away win -> NO (1)', () => expect(deriveOutcome(2, 3)).toBe(1))
  it('draw -> NO (1), because a draw belongs in NO', () => expect(deriveOutcome(1, 1)).toBe(1))
})

describe('Brier score', () => {
  it('perfect predictions score 0', () => {
    expect(brier([{ p: 1, y: 1 }, { p: 0, y: 0 }])).toBe(0)
  })
  it('coin-flip predictions score 0.25', () => {
    expect(brier([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }])).toBeCloseTo(0.25, 9)
  })
})

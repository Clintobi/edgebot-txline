import { describe, expect, it } from 'vitest'
import { oddsTicks, proposeTrade, scoreEvents } from '../lib/repricer.mjs'

describe('per-tick repricer', () => {
  it('normalizes only matching 1X2 ticks from wrapped stream payloads', () => {
    const ticks = oddsTicks({ data: [
      { FixtureId: 9, SuperOddsType: 'TXLineStablePriceDemargined1X2', Pct: [60, 20, 20], Timestamp: 1000 },
      { FixtureId: 10, SuperOddsType: 'TXLineStablePriceDemargined1X2', Pct: [70, 15, 15] },
      { FixtureId: 9, SuperOddsType: 'TOTALS', Pct: [50, 50] },
    ] }, 9)
    expect(ticks).toHaveLength(1)
    expect(ticks[0]).toMatchObject({ fixtureId: 9, fair: 0.6, draw: 0.2, away: 0.2, signalAt: 1_000_000 })
  })

  it('routes only score events for the daemon fixture', () => {
    expect(scoreEvents({ data: [{ FixtureId: 9, Action: 'goal' }, { FixtureId: 10, Action: 'goal' }] }, 9)).toEqual([{ FixtureId: 9, Action: 'goal' }])
  })

  it('re-prices each tick against the latest market pools', () => {
    const state = { bankroll: 1000, exposure: 0 }
    const common = { fixtureId: 9, draw: 0.2, away: 0.2, signalAt: 1000, bookmaker: 'TxLINE' }
    const first = proposeTrade({ ...common, fair: 0.60 }, { yes: 100, no: 100 }, state, { now: 1100 })
    const second = proposeTrade({ ...common, fair: 0.52, signalAt: 2000 }, { yes: 150, no: 100 }, state, { now: 2100 })
    expect(first).toMatchObject({ marketYes: 0.5, side: 'YES' })
    expect(first.edge).toBeCloseTo(0.1)
    expect(second).toMatchObject({ marketYes: 0.6, side: 'NO' })
    expect(second.edge).toBeCloseTo(0.08)
  })
})

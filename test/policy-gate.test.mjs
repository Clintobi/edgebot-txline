import { describe, expect, it } from 'vitest'
import fs from 'fs'
import { GateLedger, decideTrade, verifyGateLedger } from '../lib/policy-gate.mjs'

const baseIntent = overrides => ({
  fixtureId: 42,
  tickId: 'tick',
  signalAt: 1_000,
  decidedAt: 1_100,
  bookmaker: 'TxLINE',
  fair: 0.60,
  marketYes: 0.50,
  edge: 0.10,
  side: 'YES',
  amount: 50,
  pools: { yes: 100, no: 100 },
  ...overrides,
})
const state = overrides => ({ bankroll: 1000, exposure: 0, allowedFixtureIds: new Set([42]), halted: null, ...overrides })

describe('pre-trade policy gate', () => {
  it('allows an in-envelope trade', () => {
    expect(decideTrade(baseIntent(), state()).decision).toBe('ALLOW')
  })

  it.each([
    ['stale', baseIntent({ decidedAt: 500_000 })],
    ['bad fair', baseIntent({ fair: NaN })],
    ['not allowlisted', baseIntent({ fixtureId: 7 })],
    ['thin edge', baseIntent({ edge: 0.01 })],
    ['oversized order', baseIntent({ amount: 51 })],
  ])('denies %s fail-closed', (_name, intent) => {
    expect(decideTrade(intent, state()).decision).toBe('DENY')
  })

  it('denies the order that would breach aggregate exposure', () => {
    expect(decideTrade(baseIntent(), state({ exposure: 160 })).decision).toBe('DENY')
  })
})

describe('gate ledger', () => {
  it('hash-chains allow and deny decisions and detects tampering', () => {
    const path = `/tmp/edgebot-gate-${process.pid}-${Date.now()}.jsonl`
    const ledger = new GateLedger(path)
    const intent = baseIntent()
    ledger.record({ intent, result: { decision: 'ALLOW', reasons: ['inside policy envelope'] }, executed: true, executionId: 'paper:1' })
    ledger.record({ intent: baseIntent({ tickId: 'tick-2', edge: 0.01 }), result: { decision: 'DENY', reasons: ['edge below autonomous threshold'] } })
    const original = fs.readFileSync(path, 'utf8')
    expect(verifyGateLedger(original)).toMatchObject({ valid: true, count: 2 })
    expect(verifyGateLedger(original.replace('ALLOW', 'DENY'))).toMatchObject({ valid: false })
    fs.writeFileSync(path, original.replace('ALLOW', 'DENY'))
    expect(() => new GateLedger(path)).toThrow(/integrity failure/)
    fs.unlinkSync(path)
  })
})

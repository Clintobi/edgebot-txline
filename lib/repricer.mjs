import { createHash } from 'crypto'
import { fractionalKelly } from '../lib.mjs'

export const payloadRecords = value => {
  if (Array.isArray(value)) return value.flatMap(payloadRecords)
  if (!value || typeof value !== 'object') return []
  for (const key of ['data', 'Data', 'items', 'Items', 'odds', 'Odds']) {
    if (key in value) return payloadRecords(value[key])
  }
  return [value]
}

const field = (record, names) => {
  for (const name of names) if (record[name] !== undefined) return record[name]
  const wanted = new Set(names.map(x => x.toLowerCase().replace(/[^a-z0-9]/g, '')))
  const key = Object.keys(record).find(x => wanted.has(x.toLowerCase().replace(/[^a-z0-9]/g, '')))
  return key ? record[key] : undefined
}

export function oddsTicks(payload, fixtureId) {
  return payloadRecords(payload).filter(record => {
    const id = Number(field(record, ['FixtureId', 'fixtureId', 'fixture_id']))
    const kind = String(field(record, ['SuperOddsType', 'superOddsType', 'market']) || '')
    const pct = field(record, ['Pct', 'pct'])
    return id === Number(fixtureId) && kind.toUpperCase().includes('1X2') && Array.isArray(pct) && pct.length >= 3
  }).map(record => {
    const pct = field(record, ['Pct', 'pct']).map(Number)
    const timestampValue = field(record, ['Timestamp', 'timestamp', 'Ts', 'ts', 'UpdatedAt', 'updatedAt'])
    const parsedTimestamp = Number(timestampValue)
    const signalAt = Number.isFinite(parsedTimestamp)
      ? (parsedTimestamp < 1e12 ? parsedTimestamp * 1000 : parsedTimestamp)
      : (Date.parse(timestampValue) || Date.now())
    return {
      fixtureId: Number(fixtureId),
      fair: pct[0] / 100,
      draw: pct[1] / 100,
      away: pct[2] / 100,
      signalAt,
      bookmaker: field(record, ['Bookmaker', 'bookmaker']) || 'TxLINE',
      raw: record,
    }
  })
}

export function scoreEvents(payload, fixtureId) {
  return payloadRecords(payload).filter(record => Number(field(record, ['FixtureId', 'fixtureId', 'fixture_id'])) === Number(fixtureId))
}

export const tickFingerprint = tick => createHash('sha256').update(JSON.stringify([
  tick.fixtureId, tick.fair, tick.draw, tick.away, tick.signalAt, tick.bookmaker,
])).digest('hex')

export function proposeTrade(tick, market, state, options = {}) {
  const marketYes = market.yes + market.no > 0 ? market.yes / (market.yes + market.no) : 0
  const signedEdge = tick.fair - marketYes
  const side = signedEdge >= 0 ? 'YES' : 'NO'
  const fairSide = side === 'YES' ? tick.fair : 1 - tick.fair
  const marketSide = side === 'YES' ? marketYes : 1 - marketYes
  const edge = fairSide - marketSide
  const fraction = Math.min(
    fractionalKelly(fairSide, marketSide, options.kellyFraction ?? 0.25),
    options.maxOrderFraction ?? 0.05,
    Math.max(0, (options.maxExposureFraction ?? 0.20) - state.exposure / state.bankroll),
  )
  return {
    fixtureId: tick.fixtureId,
    tickId: tickFingerprint(tick),
    signalAt: tick.signalAt,
    decidedAt: options.now ?? Date.now(),
    bookmaker: tick.bookmaker,
    fair: tick.fair,
    marketYes,
    edge,
    side,
    amount: Math.round(fraction * state.bankroll),
    pools: { yes: market.yes, no: market.no },
  }
}

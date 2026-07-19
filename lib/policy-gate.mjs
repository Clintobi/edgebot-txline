import { createHash } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'

export const DEFAULT_POLICY = Object.freeze({
  minEdge: 0.03,
  maxPlausibleEdge: 0.50,
  maxSignalAgeMs: 5 * 60_000,
  maxOrderFraction: 0.05,
  maxExposureFraction: 0.20,
  minOrderUnits: 1,
})

const finite = (...values) => values.every(Number.isFinite)

// One deterministic seam sits immediately before every executor call.
// A malformed or stale intent always fails closed.
export function decideTrade(intent, state, policy = DEFAULT_POLICY) {
  const deny = reason => ({ decision: 'DENY', reasons: [reason] })
  if (!intent || typeof intent !== 'object') return deny('malformed intent')
  if (!finite(intent.fair, intent.marketYes, intent.edge, intent.amount, intent.signalAt, intent.decidedAt)) return deny('non-finite trade field')
  if (!(intent.fair > 0 && intent.fair < 1)) return deny('fair probability outside (0,1)')
  if (!(intent.marketYes >= 0 && intent.marketYes <= 1)) return deny('market probability outside [0,1]')
  if (!['YES', 'NO'].includes(intent.side)) return deny('unsupported side')
  if (!state.allowedFixtureIds?.has(Number(intent.fixtureId))) return deny('fixture is not allowlisted')
  if (intent.decidedAt - intent.signalAt > policy.maxSignalAgeMs) return deny('stale odds tick')
  if (intent.decidedAt < intent.signalAt) return deny('signal timestamp is in the future')
  if (intent.edge < policy.minEdge) return deny('edge below autonomous threshold')
  if (intent.edge > policy.maxPlausibleEdge) return deny('implausible edge; feed or market requires review')
  if (!(intent.amount >= policy.minOrderUnits)) return deny('order amount below minimum')
  if (intent.amount > state.bankroll * policy.maxOrderFraction + 1e-9) return deny('per-order cap exceeded')
  if (state.exposure + intent.amount > state.bankroll * policy.maxExposureFraction + 1e-9) return deny('aggregate exposure cap exceeded')
  if (state.halted) return deny(`kill switch active: ${state.halted}`)
  return { decision: 'ALLOW', reasons: ['inside policy envelope'] }
}

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  return JSON.stringify(value)
}

export const hashLedgerEntry = entry => createHash('sha256').update(canonical(entry)).digest('hex')

export class GateLedger {
  constructor(path) {
    this.path = path
    this.previousHash = 'GENESIS'
    if (path && existsSync(path)) {
      const text = readFileSync(path, 'utf8')
      const audit = verifyGateLedger(text)
      if (!audit.valid) throw new Error(`policy ledger integrity failure: ${audit.error}`)
      const last = text.trim().split('\n').filter(Boolean).at(-1)
      if (last) this.previousHash = JSON.parse(last).hash
    }
  }

  record({ intent, result, executed = false, executionId = null, executionError = null }) {
    const unsigned = {
      version: 1,
      sequencePreviousHash: this.previousHash,
      recordedAt: new Date(intent.decidedAt).toISOString(),
      decision: result.decision,
      reasons: result.reasons,
      intent,
      executed,
      executionId,
      executionError,
    }
    const entry = { ...unsigned, hash: hashLedgerEntry(unsigned) }
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true })
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    }
    this.previousHash = entry.hash
    return entry
  }
}

export function verifyGateLedger(text) {
  let previousHash = 'GENESIS'
  let count = 0
  for (const line of text.trim().split('\n').filter(Boolean)) {
    const entry = JSON.parse(line)
    const { hash, ...unsigned } = entry
    if (unsigned.sequencePreviousHash !== previousHash) return { valid: false, count, error: 'hash-chain link mismatch' }
    if (hashLedgerEntry(unsigned) !== hash) return { valid: false, count, error: 'entry hash mismatch' }
    previousHash = hash
    count += 1
  }
  return { valid: true, count, head: previousHash }
}

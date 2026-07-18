// build-universe.mjs — expand universe.json by probing fid clusters for FINISHED fixtures
// that have a real full-time score (goal stat keys 1,2). Chain-free: this only reads TxLINE
// data so the CLV backtest can run over a much larger N. Merges with the existing universe.
//   CREDS=... node build-universe.mjs
import fs from 'fs'
const API = 'https://txline-dev.txodds.com'
const creds = JSON.parse(fs.readFileSync(process.env.CREDS || '/Users/mac/fulltime-keys/txline-creds.json', 'utf8'))
const apiToken = typeof creds.apiToken === 'string' ? creds.apiToken : creds.apiToken.token
let JWT = null
async function tx(p) {
  if (!JWT) JWT = (await (await fetch(`${API}/auth/guest/start`, { method: 'POST' })).json()).token
  const r = await fetch(`${API}/api${p}`, { headers: { Authorization: `Bearer ${JWT}`, 'X-Api-Token': apiToken } })
  if (!r.ok) return null
  return r.json().catch(() => null)
}

// A fixture is usable if TxLINE reports a finalised record carrying both goal stats.
async function finishedFixture(fid) {
  const rows = await tx(`/scores/snapshot/${fid}`)
  if (!Array.isArray(rows) || !rows.length) return null
  const isFinal = r => r.Action === 'game_finalised' || r.StatusId === 100 || r.Period === 100
  const withGoals = rows.filter(r => r.Stats && r.Stats['1'] != null && r.Stats['2'] != null)
  const rec = withGoals.sort((a, b) => (b.Seq || 0) - (a.Seq || 0)).find(isFinal)
  if (!rec) return null
  const any = rows.find(r => r.Participant1Id || r.Participant2Id) || {}
  const g1 = Number(rec.Stats['1']), g2 = Number(rec.Stats['2'])
  if (!Number.isFinite(g1) || !Number.isFinite(g2)) return null
  return { fid, g1, g2, p1: any.Participant1Id || 0, p2: any.Participant2Id || 0, comp: any.CompetitionId || 0 }
}

async function pool(items, n, fn) {
  const q = [...items], out = []
  await Promise.all(Array.from({ length: n }, async () => { while (q.length) out.push(await fn(q.shift())) }))
  return out
}

// Probe ranges: the dense World Cup block around 17588300, plus windows around every
// other known finished fid so we catch same-competition neighbours.
const existing = JSON.parse(fs.readFileSync(new URL('./universe.json', import.meta.url), 'utf8'))
const seed = [...new Set(existing.map(u => u.fid))]
const ranges = new Set()
for (let f = 17588260; f <= 17588560; f++) ranges.add(f)          // primary dense block
for (const base of [18175918, 18179549, 18185036, 18192996, 18193785, 18202701]) // provable clusters
  for (let d = -30; d <= 30; d++) ranges.add(base + d)
const toProbe = [...ranges]
process.stderr.write(`probing ${toProbe.length} candidate fids for finished fixtures...\n`)

let done = 0, hits = 0
const found = (await pool(toProbe, 6, async fid => {
  const r = await finishedFixture(fid)
  if (++done % 50 === 0) process.stderr.write(`  ${done}/${toProbe.length} probed, ${hits} finished so far\n`)
  if (r) hits++
  return r
})).filter(Boolean)

// merge + dedup by fid
const byFid = new Map(existing.map(u => [u.fid, u]))
for (const f of found) if (!byFid.has(f.fid)) byFid.set(f.fid, f)
const merged = [...byFid.values()].sort((a, b) => a.fid - b.fid)
fs.writeFileSync(new URL('./universe.json', import.meta.url), JSON.stringify(merged, null, 0))
process.stderr.write(`\nfound ${found.length} finished fixtures · universe now ${merged.length} (was ${existing.length})\n`)
console.log(JSON.stringify({ probed: toProbe.length, found: found.length, universeSize: merged.length }))

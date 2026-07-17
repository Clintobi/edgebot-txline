// fetch-odds-cache.mjs — extract just the PRE-KICKOFF 1X2 demargined ticks per fixture
// and cache them, so backtest.mjs doesn't re-download the 27MB full odds history.
// Streams the response and aborts once the in-running flood begins (pre-KO ticks come
// first), so we pull only a few MB instead of 27.
//   CREDS=txline-creds.json node fetch-odds-cache.mjs
import fs from 'fs'
const API = 'https://txline-dev.txodds.com'
const creds = JSON.parse(fs.readFileSync(process.env.CREDS || '/Users/mac/fulltime-keys/txline-creds.json', 'utf8'))
const apiToken = typeof creds.apiToken === 'string' ? creds.apiToken : creds.apiToken.token
const uniPath = new URL('./universe.json', import.meta.url)
const universe = JSON.parse(fs.readFileSync(uniPath, 'utf8'))
const jwt = (await (await fetch(`${API}/auth/guest/start`, { method: 'POST' })).json()).token
const H = { Authorization: `Bearer ${jwt}`, 'X-Api-Token': apiToken }

// Stream odds history, keep only pre-KO 1X2 ticks, and stop at the FIRST in-running
// tick of ANY market (= kickoff has passed, so the last pre-KO tick is the true close).
async function preKoTicks(fid) {
  const ctl = new AbortController()
  const res = await fetch(`${API}/api/odds/updates/${fid}`, { headers: H, signal: ctl.signal })
  if (!res.ok || !res.body) return { fid, ticks: [], bytes: 0 }
  const reader = res.body.getReader(), dec = new TextDecoder()
  let buf = '', bytes = 0, kickoff = false
  const ticks = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.length
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('}')) !== -1) {
        const start = buf.lastIndexOf('{', i)
        if (start === -1) { buf = buf.slice(i + 1); continue }
        const obj = buf.slice(start, i + 1)
        buf = buf.slice(i + 1)
        if (/"InRunning":true/.test(obj)) { kickoff = true; break }   // kickoff — stop collecting
        if (!obj.includes('1X2')) continue
        const m = obj.match(/"Pct":\[([^\]]*)\]/)
        if (!m) continue
        const pct = m[1].split(',').map(s => s.replace(/"/g, '').trim())
        if (pct.length < 3 || pct.some(x => x === 'NA' || x === '')) continue
        const tsm = obj.match(/"Ts":(\d+)/)
        if (tsm) ticks.push({ ts: Number(tsm[1]), pYes: Number(pct[0]) / 100 })
      }
      if (kickoff && ticks.length > 4) { ctl.abort(); break }
      if (bytes > 26_000_000) { ctl.abort(); break }               // whole response — no kickoff marker
    }
  } catch { /* aborted */ }
  ticks.sort((a, b) => a.ts - b.ts)
  return { fid, ticks, bytes }
}

// limited-concurrency map
async function pool(items, n, fn) {
  const out = [], q = [...items.entries()]
  const workers = Array.from({ length: n }, async () => {
    while (q.length) { const [i, it] = q.shift(); out[i] = await fn(it) }
  })
  await Promise.all(workers)
  return out
}

const seen = new Set()
const uniq = universe.filter(u => !seen.has(u.fid) && seen.add(u.fid))
const cache = {}
await pool(uniq, 3, async u => {
  const t0 = Date.now()
  const { ticks, bytes } = await preKoTicks(u.fid)
  cache[u.fid] = { g1: u.g1, g2: u.g2, p1: u.p1, p2: u.p2, ticks }
  process.stderr.write(`  ${u.fid}: ${ticks.length} preKO ticks (${(bytes/1e6).toFixed(1)}MB, ${Date.now()-t0}ms)\n`)
})
const outPath = new URL('./odds-cache.json', import.meta.url)
fs.writeFileSync(outPath, JSON.stringify(cache))
process.stderr.write(`cached ${Object.keys(cache).length} fixtures -> odds-cache.json\n`)

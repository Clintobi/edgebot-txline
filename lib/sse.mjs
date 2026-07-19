// Minimal dependency-free SSE parser and reconnecting client.
// Handles split chunks, CRLF, multi-line data, comments, retry hints and Last-Event-ID.

export function parseSseBlock(block) {
  const message = { data: '' }
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue
    const colon = rawLine.indexOf(':')
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon)
    const value = colon === -1 ? '' : rawLine.slice(colon + 1).replace(/^ /, '')
    if (field === 'data') message.data += `${value}\n`
    else if (field === 'event') message.event = value
    else if (field === 'id' && !value.includes('\0')) message.id = value
    else if (field === 'retry' && /^\d+$/.test(value)) message.retry = Number(value)
  }
  message.data = message.data.replace(/\n$/, '')
  return message.data || message.event || message.id ? message : null
}

export async function* readSseMessages(body) {
  if (!body) throw new Error('SSE response has no body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let match = buffer.match(/\r?\n\r?\n/)
      while (match?.index !== undefined) {
        const message = parseSseBlock(buffer.slice(0, match.index))
        buffer = buffer.slice(match.index + match[0].length)
        if (message) yield message
        match = buffer.match(/\r?\n\r?\n/)
      }
      if (done) break
    }
    const tail = parseSseBlock(buffer)
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}

export const parseSseData = data => {
  try { return JSON.parse(data) } catch { return data }
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || new Error('aborted'))
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new Error('aborted')) }, { once: true })
})

export async function* reconnectingSse({ url, headers, signal, fetchImpl = fetch, minRetryMs = 500, maxRetryMs = 15_000, onStatus = () => {} }) {
  let lastEventId = ''
  let attempt = 0
  let serverRetryMs = minRetryMs
  while (!signal?.aborted) {
    try {
      const resolvedHeaders = typeof headers === 'function' ? await headers() : headers
      const response = await fetchImpl(url, {
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...(resolvedHeaders || {}),
          ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
        },
        signal,
      })
      if (!response.ok) throw new Error(`SSE ${response.status} ${response.statusText}`)
      const type = response.headers.get('content-type') || ''
      if (!type.includes('text/event-stream')) throw new Error(`expected text/event-stream, received ${type || 'no content-type'}`)
      onStatus({ state: 'connected', attempt, lastEventId })
      attempt = 0
      for await (const message of readSseMessages(response.body)) {
        if (message.id !== undefined) lastEventId = message.id
        if (message.retry !== undefined) serverRetryMs = Math.min(maxRetryMs, Math.max(minRetryMs, message.retry))
        yield message
      }
      throw new Error('SSE connection ended')
    } catch (error) {
      if (signal?.aborted) break
      attempt += 1
      const retryMs = Math.min(maxRetryMs, Math.max(serverRetryMs, minRetryMs * 2 ** Math.min(attempt - 1, 5)))
      onStatus({ state: 'reconnecting', attempt, retryMs, error: error.message })
      await wait(retryMs, signal)
    }
  }
}

import { describe, expect, it } from 'vitest'
import { parseSseBlock, readSseMessages } from '../lib/sse.mjs'

describe('SSE parser', () => {
  it('parses comments, ids, retry and multiline data', () => {
    expect(parseSseBlock(': heartbeat\nid: 7\nevent: odds\nretry: 1200\ndata: {"a":\ndata: 1}')).toEqual({
      data: '{"a":\n1}', event: 'odds', id: '7', retry: 1200,
    })
  })

  it('preserves messages split across arbitrary chunks', async () => {
    const chunks = ['id: 1\nda', 'ta: first\n\nid: 2\r\n', 'data: second\r\n\r\n']
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
    const messages = []
    for await (const message of readSseMessages(body)) messages.push(message)
    expect(messages).toEqual([{ data: 'first', id: '1' }, { data: 'second', id: '2' }])
  })
})

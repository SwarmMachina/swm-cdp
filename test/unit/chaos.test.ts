import assert from 'node:assert/strict'
import test from 'node:test'

import { connectWith } from '../../src/cdp/connect.js'
import type { CdpRequest } from '../../src/types.js'

class FakeSocket extends EventTarget {
  binaryType: BinaryType = 'blob'
  bufferedAmount = 0
  readonly #respond: boolean
  #closed = false

  constructor(respond: boolean) {
    super()
    this.#respond = respond
    setImmediate(() => this.dispatchEvent(new Event('open')))
  }

  close(): void {
    this.disconnect()
  }

  disconnect(error?: Error): void {
    if (this.#closed) {
      return
    }

    this.#closed = true

    if (error) {
      const event = new Event('error') as Event & { error?: Error }

      event.error = error
      this.dispatchEvent(event)
    }

    this.dispatchEvent(new Event('close'))
  }

  send(raw: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (!this.#respond) {
      return
    }

    if (typeof raw !== 'string') {
      throw new TypeError('Expected a text WebSocket message')
    }

    const request = JSON.parse(raw) as CdpRequest

    setImmediate(() => {
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ id: request.id, result: { value: 42 } })
        })
      )
    })
  }
}

test('all in-flight commands reject after disconnect and a new client can reconnect', async () => {
  const sockets: FakeSocket[] = []
  const first = await connectWith('ws://127.0.0.1:9222/devtools/browser/chaos', undefined, () => {
    const socket = new FakeSocket(false)

    sockets.push(socket)

    return socket
  })
  const pending = Array.from({ length: 32 }, (_, index) =>
    first.send('Runtime.evaluate', { expression: String(index) })
  )

  sockets[0]!.disconnect(new Error('connection reset'))

  const settled = await Promise.allSettled(pending)

  assert.equal(
    settled.every((result) => result.status === 'rejected'),
    true
  )
  assert.equal(first.closed, true)

  const second = await connectWith('ws://127.0.0.1:9222/devtools/browser/chaos', undefined, () => new FakeSocket(true))

  assert.deepEqual(await second.send('Runtime.evaluate', { expression: '6 * 7' }), { value: 42 })
  await second.close()
})

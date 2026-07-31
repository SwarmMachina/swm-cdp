import assert from 'node:assert/strict'
import test from 'node:test'

import { connect } from '../../src/index.js'
import { connectWith } from '../../src/cdp/connect.js'
import type { CdpRequest } from '../../src/types.js'

class FakeWebSocket extends EventTarget {
  binaryType: BinaryType = 'blob'
  bufferedAmount = 0
  terminated = false
  readonly #requests: CdpRequest[]

  constructor(requests: CdpRequest[]) {
    super()
    this.#requests = requests
    setImmediate(() => this.dispatchEvent(new Event('open')))
  }

  send(raw: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof raw !== 'string') {
      throw new TypeError('Expected a text WebSocket message')
    }

    const request = JSON.parse(raw) as CdpRequest

    this.#requests.push(request)
    setImmediate(() => {
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ id: request.id, result: { product: 'Test Chrome' } })
        })
      )
    })
  }

  close(): void {
    this.terminated = true
  }
}

test('connect owns only a remote WebSocket connection', async () => {
  const requests: CdpRequest[] = []
  const remote = await connectWith(
    'ws://127.0.0.1:9222/devtools/browser/test',
    undefined,
    () => new FakeWebSocket(requests)
  )

  assert.equal(typeof remote.close, 'function')
  assert.equal(typeof remote.send, 'function')
  assert.equal(remote.closed, false)
  assert.deepEqual(await remote.send('Browser.getVersion'), { product: 'Test Chrome' })

  const closing = remote.close()

  assert.equal(remote.close(), closing)
  await closing
  assert.equal(remote.closed, true)
  assert.deepEqual(
    requests.map((request) => request.method),
    ['Browser.getVersion']
  )
})

test('connect validates endpoint and remote-only options before opening a socket', async () => {
  await assert.rejects(connect('http://127.0.0.1:9222'), /protocol must be ws: or wss:/)
  await assert.rejects(connect('ws://example.com:9222'), /must use a loopback address/)
  await assert.rejects(connect({ host: '192.168.1.10', port: 9222 }), /must use a loopback address/)
  await assert.rejects(connect('not a URL'), /valid URL/)
  // @ts-expect-error Runtime validation rejects non-endpoint values.
  await assert.rejects(connect(42), /URL string, URL, or connection options/)
  // @ts-expect-error Runtime validation rejects launch-only options.
  await assert.rejects(connect('ws://127.0.0.1:9222', { headless: true }), /unknown connect option headless/)
})

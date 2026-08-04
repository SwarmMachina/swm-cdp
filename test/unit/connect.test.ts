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

test('connect resolves a host and port through Chrome discovery', async () => {
  const requests: CdpRequest[] = []

  let socketUrl: string | undefined
  let discoveryTarget: unknown
  let discoveryTimeout: number | undefined

  const remote = await connectWith(
    { host: '127.0.0.1', port: 9222 },
    { attachTimeout: 1_000 },
    (url) => {
      socketUrl = url

      return new FakeWebSocket(requests)
    },
    async (target, options) => {
      discoveryTarget = target
      discoveryTimeout = options?.timeout

      return {
        Browser: 'Test Chrome',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/discovered'
      }
    }
  )

  try {
    assert.deepEqual(discoveryTarget, { host: '127.0.0.1', port: 9222, secure: false })
    assert.equal(discoveryTimeout, 1_000)
    assert.equal(socketUrl, 'ws://127.0.0.1:9222/devtools/browser/discovered')
    assert.deepEqual(await remote.send('Browser.getVersion'), { product: 'Test Chrome' })
  } finally {
    await remote.close()
  }
})

test('connect rejects discovery without a browser WebSocket endpoint', async () => {
  await assert.rejects(
    connectWith({ host: '127.0.0.1', port: 9222 }, undefined, undefined, async () => ({
      Browser: 'Test Chrome',
      'Protocol-Version': '1.3'
    })),
    /did not provide a browser WebSocket endpoint/
  )
})

test('connect validates endpoint and remote-only options before opening a socket', async () => {
  await assert.rejects(connect('http://127.0.0.1:9222'), /protocol must be ws: or wss:/)
  await assert.rejects(connect('ws://example.com:9222'), /must use a loopback address/)
  await assert.rejects(connect({ host: '192.168.1.10', port: 9222 }), /must use a loopback address/)
  await assert.rejects(connect({ host: '127.0.0.1', port: -1 }), /port must be an integer/)
  // @ts-expect-error Runtime validation rejects non-boolean secure values.
  await assert.rejects(connect({ host: '127.0.0.1', secure: 'yes' }), /secure option must be a boolean/)
  await assert.rejects(connect('not a URL'), /valid URL/)
  // @ts-expect-error Runtime validation rejects non-endpoint values.
  await assert.rejects(connect(42), /complete WebSocket URL/)
  // @ts-expect-error Runtime validation rejects launch-only options.
  await assert.rejects(connect('ws://127.0.0.1:9222', { headless: true }), /unknown connect option headless/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { measureMemoryGrowth } from '@swarmmachina/benchkit/measurement'

import Connection from '../../src/cdp/connection/connection.js'
import EventRegistry from '../../src/events/event-registry.js'
import type { Transport, TransportOptions } from '../../src/types.js'

const EVENT_COUNT = 1_000_000
const MiB = 1024 * 1024

test('one million ignored events and subscription churn reach a memory plateau', async () => {
  assert.equal(typeof globalThis.gc, 'function', 'leak test must run with --expose-gc')

  const transport = new FakeTransport()
  const cdp = new Connection(transport)
  const message = JSON.stringify({
    method: 'Network.dataReceived',
    params: { dataLength: 1024, encodedDataLength: 1024, requestId: 'leak', timestamp: 1 }
  })

  for (let index = 0; index < 100_000; index += 1) {
    cdp.on('Network.dataReceived', () => {})()
  }

  assert.equal(cdp.listenerCount('Network.dataReceived'), 0)

  const growth = await measureMemoryGrowth({
    warmup: 1,
    iterations: 1,
    run: () => dispatch(cdp, message, EVENT_COUNT / 2)
  })
  const heapGrowth = growth.heapUsed.deltaBytes / MiB
  const rssGrowth = growth.rss.deltaBytes / MiB

  assert.ok(heapGrowth < 8, `heap did not plateau: ${heapGrowth.toFixed(2)} MiB`)
  assert.ok(rssGrowth < 32, `RSS did not plateau: ${rssGrowth.toFixed(2)} MiB`)
  cdp.detach()
})

test('pending map is empty after transport failure rejects every command', async () => {
  const transport = new FakeTransport()
  const cdp = new Connection(transport)
  const pending = Array.from({ length: 2_000 }, (_, index) =>
    cdp.send('Runtime.evaluate', { expression: String(index) })
  )

  assert.equal(cdp.pendingRequestCount, pending.length)
  transport.close(new Error('forced disconnect'))

  const settled = await Promise.allSettled(pending)

  assert.equal(
    settled.every((result) => result.status === 'rejected'),
    true
  )
  assert.equal(cdp.pendingRequestCount, 0)
})

function dispatch(cdp: Connection, message: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    cdp.onTransportMessage(message)
  }
}

interface FakeTransportEvents {
  close: [error?: Error]
  message: [message: string]
}

class FakeTransport implements Transport {
  readonly attached = true
  readonly attaching = false
  readonly droppedMessages = 0
  readonly options: TransportOptions = {
    debugProtocol: false,
    maxBufferedWriteBytes: Number.MAX_SAFE_INTEGER,
    maxMessageBytes: Number.MAX_SAFE_INTEGER,
    maxPendingRequests: 10_000,
    maxQueueDepth: Number.MAX_SAFE_INTEGER,
    protocolTimeout: 30_000
  }
  readonly #events = new EventRegistry<FakeTransportEvents>()
  readonly listenerCount: Transport['listenerCount'] = this.#events.listenerCount
  readonly on: Transport['on'] = this.#events.on
  readonly once: Transport['once'] = this.#events.once
  readonly removeListener: Transport['removeListener'] = this.#events.off
  #closed = false

  get closed(): boolean {
    return this.#closed
  }

  get state(): Transport['state'] {
    return this.#closed ? 'closed' : 'open'
  }

  close(error?: Error): void {
    if (!this.#closed) {
      this.#closed = true
      this.#events.emit('close', error)
    }
  }

  sendMessage(): void {}
}

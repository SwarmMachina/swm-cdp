import assert from 'node:assert/strict'
import test from 'node:test'

import CdpError from '../../src/cdp/cdp-error.js'
import Connection from '../../src/cdp/connection/connection.js'
import RequestDispatcher from '../../src/cdp/request-dispatcher.js'
import EventRegistry from '../../src/events/event-registry.js'
import type { CdpRequest, LogEntry, Transport, TransportOptions } from '../../src/types.js'

interface FakeTransportEvents {
  close: [error?: Error]
  message: [message: string]
}

class FakeTransport implements Transport {
  readonly attached = true
  readonly attaching = false
  readonly droppedMessages = 0
  readonly sent: CdpRequest[] = []
  readonly closeCalls: (Error | undefined)[] = []
  readonly #events = new EventRegistry<FakeTransportEvents>()
  readonly listenerCount: Transport['listenerCount']
  readonly on: Transport['on']
  readonly once: Transport['once']
  readonly removeListener: Transport['removeListener']
  readonly options: TransportOptions
  #closed = false

  constructor(options: Partial<TransportOptions> = {}) {
    this.options = {
      debugProtocol: false,
      maxBufferedWriteBytes: Number.MAX_SAFE_INTEGER,
      maxMessageBytes: Number.MAX_SAFE_INTEGER,
      maxPendingRequests: 10_000,
      maxQueueDepth: Number.MAX_SAFE_INTEGER,
      protocolTimeout: 100,
      ...options
    }
    this.listenerCount = this.#events.listenerCount
    this.on = this.#events.on
    this.once = this.#events.once
    this.removeListener = this.#events.off
  }

  get closed(): boolean {
    return this.#closed
  }

  get state(): Transport['state'] {
    return this.#closed ? 'closed' : 'open'
  }

  sendMessage(message: string): void {
    this.sent.push(JSON.parse(message) as CdpRequest)
  }

  close(error?: Error): void {
    if (this.#closed) {
      return
    }

    this.#closed = true
    this.closeCalls.push(error)
    this.#events.emit('close', error)
  }

  emit<Name extends keyof FakeTransportEvents>(event: Name, ...args: FakeTransportEvents[Name]): void {
    this.#events.emit(event, ...args)
  }
}

test('EventRegistry keeps once and in-flight subscription changes explicit', () => {
  const recursiveEvents = new EventRegistry<{ event: [value: number] }>()
  const calls: string[] = []

  recursiveEvents.once('event', (value) => {
    calls.push(`once:${value}`)
    recursiveEvents.emit('event', value + 1)
  })
  recursiveEvents.on('event', (value) => calls.push(`persistent:${value}`))
  recursiveEvents.emit('event', 1)

  const changingEvents = new EventRegistry<{ event: [value: number] }>()

  let added = false
  let unsubscribeSecond = (): void => undefined

  changingEvents.on('event', (value) => {
    calls.push(`first:${value}`)
    unsubscribeSecond()

    if (!added) {
      added = true
      changingEvents.on('event', (nextValue) => calls.push(`late:${nextValue}`))
    }
  })
  unsubscribeSecond = changingEvents.on('event', (value) => calls.push(`second:${value}`))

  changingEvents.emit('event', 3)
  changingEvents.emit('event', 4)

  assert.deepEqual(calls, ['once:1', 'persistent:2', 'persistent:1', 'first:3', 'first:4', 'late:4'])
})

test('RequestDispatcher matches CDP responses by request id', async () => {
  const transport = new FakeTransport()
  const dispatcher = new RequestDispatcher(transport, 100)
  const responsePromise = dispatcher.send({
    method: 'Browser.getVersion'
  })
  const request = transport.sent[0]!

  assert.equal(request.id, 1)
  assert.equal(request.method, 'Browser.getVersion')

  dispatcher.resolve({ id: request.id!, result: { product: 'Chrome/Test' } })

  const response = await responsePromise

  assert.deepEqual(response.result, { product: 'Chrome/Test' })
  assert.equal(response.req!.method, 'Browser.getVersion')
})

test('RequestDispatcher keeps local request metadata outside the wire payload', async () => {
  const transport = new FakeTransport()
  const dispatcher = new RequestDispatcher(transport, 100)
  const request = {
    method: 'Browser.getVersion',
    options: { timeout: 100 }
  }
  const responsePromise = dispatcher.send(request)
  const wireRequest = transport.sent[0]!

  assert.equal('id' in request, false)
  assert.equal('options' in wireRequest, false)

  dispatcher.resolve({ id: wireRequest.id!, result: {} })
  await responsePromise
})

test('ProtocolError type guard is safe for arbitrary values', () => {
  const error = new CdpError({ method: 'Browser.getVersion' }, { id: 1, error: { message: 'failed' } })

  assert.equal(CdpError.isProtocolError(error), true)
  assert.equal(CdpError.isProtocolError(null), false)
  assert.equal(CdpError.isProtocolError({ name: 'ProtocolError' }), false)
})

test('RequestDispatcher resolves timed out requests with an error response', async () => {
  const transport = new FakeTransport()
  const dispatcher = new RequestDispatcher(transport, 100)
  const response = await dispatcher.send({
    method: 'Never.responds',
    options: { timeout: 1 }
  })

  assert.equal(response.error!.message, 'Request timeout exceeded')
  assert.equal(response.req!.method, 'Never.responds')
})

test('Connection routes target attach, session events, target updates, and detach', async () => {
  const transport = new FakeTransport()
  const root = new Connection(transport)
  const attachedEvents: unknown[] = []
  const rootSessionEvents: { event: unknown; sessionId?: string }[] = []

  assert.equal('protocol' in root, false)

  root.on('Target.attachedToTarget', (event) => attachedEvents.push(event))
  root.on('Page.lifecycleEvent', (event, sessionId) => rootSessionEvents.push({ event, sessionId }))

  root.onTransportMessage(
    JSON.stringify({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'session-1',
        targetInfo: {
          targetId: 'target-1',
          type: 'page',
          url: 'about:blank'
        }
      }
    })
  )

  assert.equal(attachedEvents.length, 1)

  const session = root.getConnection({ targetId: 'target-1' }, true)

  assert.equal(typeof session.send, 'function')
  assert.equal(session.sessionId, 'session-1')

  const lifecycleEvents: unknown[] = []

  session.on('Page.lifecycleEvent', (event) => lifecycleEvents.push(event))

  root.onTransportMessage(
    JSON.stringify({
      sessionId: 'session-1',
      method: 'Page.lifecycleEvent',
      params: { name: 'load' }
    })
  )

  assert.deepEqual(lifecycleEvents, [{ name: 'load' }])
  assert.deepEqual(rootSessionEvents, [{ event: { name: 'load' }, sessionId: 'session-1' }])

  root.onTransportMessage(
    JSON.stringify({
      method: 'Target.targetInfoChanged',
      params: {
        targetInfo: {
          targetId: 'target-1',
          type: 'page',
          url: 'https://example.test/'
        }
      }
    })
  )

  assert.equal(session.targetInfo!.url, 'https://example.test/')

  root.onTransportMessage(
    JSON.stringify({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'session-1' }
    })
  )

  assert.equal(session.closed, true)
  assert.throws(() => root.getConnection({ targetId: 'target-1' }, true), /is not attached/)
})

test('Connection updates session state before attach and detach events are emitted', () => {
  const transport = new FakeTransport()
  const root = new Connection(transport)

  let session: Connection | undefined

  root.on('Target.attachedToTarget', ({ targetInfo }) => {
    session = root.getConnection(targetInfo, true)
    assert.equal(session!.closed, false)
  })

  root.onTransportMessage(
    JSON.stringify({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'session-1',
        targetInfo: { targetId: 'target-1' }
      }
    })
  )

  root.on('Target.detachedFromTarget', () => {
    assert.equal(session!.closed, true)
    assert.throws(() => root.getConnection({ targetId: 'target-1' }, true), /is not attached/)
  })

  root.onTransportMessage(
    JSON.stringify({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'session-1' }
    })
  )

  root.detach()
  assert.equal(root.closed, true)
})

test('Connection deduplicates concurrent attachment to the same target', async (t) => {
  const transport = new FakeTransport()
  const root = new Connection(transport)

  t.after(() => root.detach())

  const first = root.attachToTarget('target-1')
  const second = root.attachToTarget('target-1')

  assert.equal(transport.sent.length, 1)
  const request = transport.sent[0]!

  transport.emit(
    'message',
    JSON.stringify({
      method: 'Target.attachedToTarget',
      params: { sessionId: 'session-1', targetInfo: { targetId: 'target-1' } }
    })
  )
  transport.emit('message', JSON.stringify({ id: request.id, result: { sessionId: 'session-1' } }))

  const [firstSession, secondSession] = await Promise.all([first, second])

  assert.equal(firstSession, secondSession)
})

test('Connection fails closed on malformed wire data', () => {
  const transport = new FakeTransport()
  const root = new Connection(transport)

  transport.emit('message', '{invalid json')

  assert.equal(transport.closeCalls.length, 1)
  assert.equal(root.closed, true)
  assert.ok(root.error instanceof SyntaxError)
})

test('Connection routes nested flattened sessions through the shared registry', async (t) => {
  const transport = new FakeTransport()
  const root = new Connection(transport)

  t.after(() => root.detach())

  root.onTransportMessage(
    JSON.stringify({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'parent-session',
        targetInfo: { targetId: 'parent-target' }
      }
    })
  )

  const parent = root.getConnection({ targetId: 'parent-target' }, true)

  root.onTransportMessage(
    JSON.stringify({
      sessionId: 'parent-session',
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'child-session',
        targetInfo: { targetId: 'child-target' }
      }
    })
  )

  const child = parent.getConnection({ targetId: 'child-target' }, true)
  const events: unknown[] = []

  child.on('Runtime.consoleAPICalled', (event) => events.push(event))

  root.onTransportMessage(
    JSON.stringify({
      sessionId: 'child-session',
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log' }
    })
  )

  assert.deepEqual(events, [{ type: 'log' }])
  assert.equal(root.getConnection({ sessionId: 'child-session' }, true), child)

  const childRequest = child.send('Runtime.enable')

  root.onTransportMessage(
    JSON.stringify({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'parent-session' }
    })
  )

  await assert.rejects(childRequest, /Session child-session already closed/)
  assert.equal(parent.closed, true)
  assert.equal(child.closed, true)
})

test('Connection treats an exact duplicate attach as an idempotent target update', (t) => {
  const transport = new FakeTransport()
  const root = new Connection(transport)

  t.after(() => root.detach())

  root.onTransportMessage(
    JSON.stringify({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'session-1',
        targetInfo: { targetId: 'target-1', url: 'about:blank' }
      }
    })
  )

  const session = root.getConnection({ targetId: 'target-1' }, true)

  let closeEvents = 0

  session.on('close', () => closeEvents++)

  root.onTransportMessage(
    JSON.stringify({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'session-1',
        targetInfo: { targetId: 'target-1', url: 'https://example.test/' }
      }
    })
  )

  assert.equal(root.getConnection({ targetId: 'target-1' }, true), session)
  assert.equal(session.targetInfo!.url, 'https://example.test/')
  assert.equal(session.closed, false)
  assert.equal(closeEvents, 0)
})

test('Connection replaces a stale session when the same target is reattached', async (t) => {
  const transport = new FakeTransport()
  const root = new Connection(transport)

  t.after(() => root.detach())

  root.onTransportMessage(
    JSON.stringify({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'old-session',
        targetInfo: { targetId: 'target-1' }
      }
    })
  )

  const oldSession = root.getConnection({ targetId: 'target-1' }, true)
  const oldRequest = oldSession.send('Runtime.enable')

  root.onTransportMessage(
    JSON.stringify({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'new-session',
        targetInfo: { targetId: 'target-1' }
      }
    })
  )

  await assert.rejects(oldRequest, /Session old-session already closed/)

  const newSession = root.getConnection({ targetId: 'target-1' }, true)

  assert.notEqual(newSession, oldSession)
  assert.equal(oldSession.closed, true)
  assert.equal(newSession.sessionId, 'new-session')
  assert.throws(() => root.getConnection({ sessionId: 'old-session' }, true), /no longer attached/)

  root.onTransportMessage(
    JSON.stringify({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'old-session' }
    })
  )

  assert.equal(root.getConnection({ targetId: 'target-1' }, true), newSession)
  assert.equal(newSession.closed, false)
})

test('Connection preserves registry state when a session id collides with another target', (t) => {
  const transport = new FakeTransport()
  const root = new Connection(transport)
  const errors: Error[] = []

  t.after(() => root.detach())
  root.on<Error>('error', (error) => errors.push(error))

  root.onTransportMessage(
    JSON.stringify({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'session-1',
        targetInfo: { targetId: 'target-1' }
      }
    })
  )

  const session = root.getConnection({ targetId: 'target-1' }, true)

  root.onTransportMessage(
    JSON.stringify({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'session-1',
        targetInfo: { targetId: 'target-2' }
      }
    })
  )

  assert.match(errors[0]!.message, /already attached to target target-1/)
  assert.equal(root.getConnection({ targetId: 'target-1' }, true), session)
  assert.throws(() => root.getConnection({ targetId: 'target-2' }, true), /is not attached/)
  assert.equal(session.closed, false)
})

test('Session ownership prevents sibling access and conflicting reparenting', (t) => {
  const transport = new FakeTransport()
  const root = new Connection(transport)
  const errors: Error[] = []

  t.after(() => root.detach())

  for (const id of ['parent-1', 'parent-2']) {
    root.onTransportMessage(
      JSON.stringify({
        method: 'Target.attachedToTarget',
        params: {
          sessionId: `${id}-session`,
          targetInfo: { targetId: `${id}-target` }
        }
      })
    )
  }

  const parent1 = root.getConnection({ targetId: 'parent-1-target' }, true)
  const parent2 = root.getConnection({ targetId: 'parent-2-target' }, true)

  parent2.on<Error>('error', (error) => errors.push(error))

  root.onTransportMessage(
    JSON.stringify({
      sessionId: 'parent-1-session',
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'child-session',
        targetInfo: { targetId: 'child-target' }
      }
    })
  )

  const child = parent1.getConnection({ targetId: 'child-target' }, true)

  assert.throws(() => parent2.getConnection({ targetId: 'child-target' }, true), /is not owned by session/)

  root.onTransportMessage(
    JSON.stringify({
      sessionId: 'parent-2-session',
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'child-session',
        targetInfo: { targetId: 'child-target' }
      }
    })
  )

  assert.match(errors[0]!.message, /different parent/)
  assert.equal(parent1.getConnection({ targetId: 'child-target' }, true), child)
  assert.equal(child.closed, false)
})

test('Connection emits close once and removes owned transport listeners', () => {
  const transport = new FakeTransport()
  const root = new Connection(transport)

  let closeEvents = 0

  root.on('close', () => closeEvents++)

  assert.equal(transport.listenerCount('message'), 1)
  assert.equal(transport.listenerCount('close'), 1)

  transport.emit('close')
  transport.emit('close')

  assert.equal(closeEvents, 1)
  assert.equal(transport.listenerCount('message'), 0)
  assert.equal(transport.listenerCount('close'), 0)
})

test('Connection rejects pending sends when transport closes', async () => {
  const transport = new FakeTransport()
  const root = new Connection(transport)
  const requestPromise = root.send('Browser.getVersion')

  transport.emit('close')

  await assert.rejects(requestPromise, /already closed/)
})

test('Connection uses unique request ids across root and sessions', async (t) => {
  const transport = new FakeTransport()
  const root = new Connection(transport)

  t.after(() => root.detach())

  root.onTransportMessage(
    JSON.stringify({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'session-1',
        targetInfo: { targetId: 'target-1' }
      }
    })
  )

  const session = root.getConnection({ targetId: 'target-1' }, true)

  assert.equal(transport.listenerCount('message'), 1)

  const rootRequest = root.send('Browser.getVersion')
  const sessionRequest = session.send('Page.enable')
  const rootMessage = transport.sent[0]!
  const sessionMessage = transport.sent[1]!

  assert.notEqual(rootMessage.id, sessionMessage.id)

  transport.emit(
    'message',
    JSON.stringify({
      id: sessionMessage.id,
      sessionId: 'session-1',
      result: { source: 'session' }
    })
  )
  transport.emit(
    'message',
    JSON.stringify({
      id: rootMessage.id,
      result: { source: 'root' }
    })
  )

  assert.deepEqual(await rootRequest, { source: 'root' })
  assert.deepEqual(await sessionRequest, { source: 'session' })
})

test('detaching a session closes only requests owned by that session', async (t) => {
  const transport = new FakeTransport()
  const root = new Connection(transport)

  t.after(() => root.detach())

  root.onTransportMessage(
    JSON.stringify({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'session-1',
        targetInfo: { targetId: 'target-1' }
      }
    })
  )

  const session = root.getConnection({ targetId: 'target-1' }, true)
  const rootRequest = root.send('Browser.getVersion')
  const sessionRequest = session.send('Page.enable')
  const rootMessage = transport.sent[0]!

  transport.emit(
    'message',
    JSON.stringify({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'session-1' }
    })
  )

  await assert.rejects(sessionRequest, /Session session-1 already closed/)

  transport.emit(
    'message',
    JSON.stringify({
      id: rootMessage.id,
      result: { source: 'root' }
    })
  )

  assert.deepEqual(await rootRequest, { source: 'root' })
})

test('Connection applies request timeout without sending local options over CDP', async (t) => {
  const transport = new FakeTransport()
  const root = new Connection(transport)

  t.after(() => root.detach())

  const requestPromise = root.send('Browser.getVersion', undefined, { timeout: 1 })
  const request = transport.sent[0]!

  assert.equal('options' in request, false)

  setTimeout(() => {
    transport.emit('message', JSON.stringify({ id: request.id, result: { product: 'too late' } }))
  }, 10)

  await assert.rejects(requestPromise, /Request timeout exceeded/)
})

test('Connection rejects invalid local request options before transport send', async (t) => {
  const transport = new FakeTransport()
  const root = new Connection(transport)

  t.after(() => root.detach())

  await assert.rejects(root.send('Browser.getVersion', undefined, { timeout: -1 }), /Request timeout must/)
  // @ts-expect-error Runtime validation rejects non-AbortSignal values.
  await assert.rejects(root.send('Browser.getVersion', undefined, { signal: {} }), /Request signal must/)
  // @ts-expect-error Runtime validation rejects non-object operation options.
  await assert.rejects(root.send('Browser.getVersion', undefined, undefined, 'invalid'), /Request options must/)
  // @ts-expect-error Runtime validation rejects misspelled operation options.
  await assert.rejects(root.send('Browser.getVersion', undefined, { timout: 1 }), /unknown key timout/)
  // @ts-expect-error Runtime validation rejects null command parameters.
  await assert.rejects(root.send('Browser.getVersion', null), /params must be an object/)
  assert.equal(transport.sent.length, 0)
})

test('Connection aborts a pending request and ignores a late response', async (t) => {
  const transport = new FakeTransport()
  const root = new Connection(transport)
  const controller = new AbortController()

  t.after(() => root.detach())

  const requestPromise = root.send('Browser.getVersion', undefined, { signal: controller.signal })
  const request = transport.sent[0]!

  controller.abort()
  setTimeout(() => {
    transport.emit('message', JSON.stringify({ id: request.id, result: { product: 'too late' } }))
  }, 10)

  await assert.rejects(requestPromise, { name: 'AbortError' })
})

test('Connection uses the transport protocol timeout by default', async (t) => {
  const transport = new FakeTransport()

  transport.options.protocolTimeout = 1
  const root = new Connection(transport)

  t.after(() => root.detach())

  const requestPromise = root.send('Browser.getVersion')
  const request = transport.sent[0]!

  setTimeout(() => {
    transport.emit('message', JSON.stringify({ id: request.id, result: { product: 'too late' } }))
  }, 10)

  await assert.rejects(requestPromise, /Request timeout exceeded/)
})

test('Connection rejects requests above the pending request limit', async (t) => {
  const transport = new FakeTransport()

  transport.options.maxPendingRequests = 1
  const root = new Connection(transport)

  t.after(() => root.detach())

  const firstRequest = root.send('Browser.getVersion')

  firstRequest.catch(() => {})
  const firstMessage = transport.sent[0]!

  await assert.rejects(root.send('Target.getTargets', undefined, { timeout: 1 }), /Pending request limit exceeded/)
  assert.equal(transport.sent.length, 1)

  transport.emit('message', JSON.stringify({ id: firstMessage.id, result: { product: 'Chrome/Test' } }))
  await firstRequest
})

test('Connection until keeps listening until its predicate matches', async (t) => {
  const transport = new FakeTransport()
  const root = new Connection(transport)

  t.after(() => root.detach())

  const eventPromise = root.until<{ name: string }>('Page.lifecycleEvent', (event) => event.name === 'load', {
    timeout: 100
  })
  const { reject, promise: timeoutPromise } = Promise.withResolvers<never>()

  setTimeout(() => reject(new Error('test timeout')), 10)
  const guardedPromise = Promise.race([eventPromise, timeoutPromise])

  root.onTransportMessage(JSON.stringify({ method: 'Page.lifecycleEvent', params: { name: 'init' } }))
  root.onTransportMessage(JSON.stringify({ method: 'Page.lifecycleEvent', params: { name: 'load' } }))

  assert.deepEqual(await guardedPromise, { name: 'load' })
})

test('Connection until supports timeout and AbortSignal cleanup', async (t) => {
  const transport = new FakeTransport()
  const root = new Connection(transport)
  const controller = new AbortController()

  t.after(() => root.detach())

  await assert.rejects(root.until('Never.happens', undefined, { timeout: 1 }), /Event wait timeout/)

  const abortedPromise = root.until('Also.never.happens', undefined, {
    signal: controller.signal,
    timeout: 100
  })

  controller.abort()

  await assert.rejects(abortedPromise, { name: 'AbortError' })
  assert.equal(root.listenerCount('Also.never.happens'), 0)
})

test('Connection until rejects invalid operation options without listeners', async (t) => {
  const transport = new FakeTransport()
  const root = new Connection(transport)

  t.after(() => root.detach())

  // @ts-expect-error Runtime validation rejects non-AbortSignal values.
  await assert.rejects(root.until('Never.happens', undefined, { signal: {} }), /Event wait signal must/)
  // @ts-expect-error Runtime validation rejects non-object operation options.
  await assert.rejects(root.until('Never.happens', undefined, 'invalid'), /Event wait options must/)
  await assert.rejects(root.until('', undefined), /Event name must be/)
  // @ts-expect-error Runtime validation rejects non-function predicates.
  await assert.rejects(root.until('Never.happens', true), /predicate must be a function/)
  assert.equal(root.listenerCount('Never.happens'), 0)
})

test('Connection until rejects and cleans up when the connection closes', async () => {
  const transport = new FakeTransport()
  const root = new Connection(transport)
  const eventPromise = root.until('Never.happens', undefined, { timeout: 100 })

  root.detach()

  await assert.rejects(eventPromise, /Connection closed while waiting/)
  assert.equal(root.listenerCount('Never.happens'), 0)
})

test('Connection stores unobserved protocol errors without throwing', () => {
  const transport = new FakeTransport()
  const root = new Connection(transport)

  assert.doesNotThrow(() => root.onTransportMessage('{invalid json'))
  assert.ok(root.error instanceof SyntaxError)

  root.detach()
})

test('Connection emits protocol errors when a listener is registered', () => {
  const transport = new FakeTransport()
  const root = new Connection(transport)
  const errors: unknown[] = []

  root.on('error', (error) => errors.push(error))
  root.onTransportMessage('{invalid json')

  assert.equal(errors.length, 1)
  assert.equal(errors[0], root.error)

  root.detach()
})

test('Connection emits structured protocol diagnostics only for enabled debug scope', async () => {
  const entries: LogEntry[] = []
  const transport = new FakeTransport({
    debugProtocol: true,
    logger: (entry) => entries.push(entry)
  })
  const root = new Connection(transport)
  const requestPromise = root.send('Browser.getVersion')
  const request = transport.sent[0]!

  transport.emit('message', JSON.stringify({ id: request.id, result: { product: 'Chrome/Test' } }))
  await requestPromise

  assert.ok(entries.some((entry) => entry.scope === 'protocol' && entry.event === 'request.sent'))
  assert.ok(entries.some((entry) => entry.scope === 'protocol' && entry.event === 'message.received'))

  root.detach()
})

test('Connection reports errors to the configured sink even when protocol debug is disabled', () => {
  const entries: LogEntry[] = []
  const transport = new FakeTransport({ logger: (entry) => entries.push(entry) })
  const root = new Connection(transport)

  root.onTransportMessage('{invalid json')

  assert.deepEqual(
    entries.map(({ event, level, scope }) => ({ event, level, scope })),
    [{ event: 'protocol.error', level: 'error', scope: 'protocol' }]
  )

  root.detach()
})

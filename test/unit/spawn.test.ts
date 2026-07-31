import assert from 'node:assert/strict'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter, getEventListeners } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import test from 'node:test'
import PipeTransport from '../../src/cdp/transport/pipe-transport.js'
import TaskQueue from '../../src/cdp/transport/task-queue.js'
import WebSocketTransport from '../../src/cdp/transport/ws-transport.js'
import Browser from '../../src/spawn/browser.js'
import normalizeOptions from '../../src/spawn/normalize-options.js'
import ChromeProcess, { getSpawnEnv, terminateWindowsProcess } from '../../src/spawn/chrome-process.js'
import getArguments from '../../src/spawn/get-arguments.js'
import spawnChrome from '../../src/spawn/spawn-chrome.js'
import UserDataDirectory from '../../src/spawn/user-data-directory.js'
import WebSocketEndpoint from '../../src/spawn/websocket-endpoint.js'
import type { ChromeProcessLike, LaunchOptions, NormalizedLaunchOptions, WriteStreamLike } from '../../src/types.js'

function transportOptions(overrides: LaunchOptions = {}): NormalizedLaunchOptions {
  return normalizeOptions({
    attachTimeout: 50,
    debugProtocol: false,
    debugSpawn: false,
    debugTransport: false,
    maxBufferedWriteBytes: 1024,
    maxEndpointBytes: 1024,
    maxMessageBytes: 1024,
    maxPendingRequests: 100,
    maxQueueDepth: 100,
    protocolTimeout: 100,
    shutdownTimeout: 50,
    startupTimeout: 50,
    stdio: 'ignore',
    transport: 'pipe',
    userDataDir: '/tmp/profile',
    ...overrides
  })
}

class FakeWriteStream extends EventEmitter implements WriteStreamLike {
  ended = false
  writableLength = 0
  readonly writes: Uint8Array[] = []

  write(data: Uint8Array): boolean {
    this.writes.push(data)

    return true
  }

  end(): void {
    this.ended = true
  }
}

function createPipe(options: LaunchOptions = {}) {
  const readStream = new EventEmitter()
  const writeStream = new FakeWriteStream()
  const transport = new PipeTransport({ options: transportOptions(options), readStream, writeStream })

  transport.attach()

  return { readStream, transport, writeStream, writes: writeStream.writes }
}

class FakeWebSocket extends EventTarget {
  binaryType: BinaryType = 'blob'
  bufferedAmount = 0
  sent: string[] = []
  terminated = false

  send(message: string): void {
    this.sent.push(message)
  }

  close(): void {
    this.terminated = true
  }

  fail(error: Error): void {
    const event = new Event('error') as Event & { error?: Error }

    event.error = error
    this.dispatchEvent(event)
  }

  open(): void {
    this.dispatchEvent(new Event('open'))
  }

  peerClose(): void {
    this.dispatchEvent(new Event('close'))
  }

  receive(message: string | Buffer, isBinary = false): void {
    const bytes = Buffer.from(message)
    const data = isBinary ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes.toString()

    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

function createFakeWebSocketTransport(options: LaunchOptions = {}) {
  const socket = new FakeWebSocket()
  const transport = new WebSocketTransport({
    createWebSocket: () => socket,
    options: transportOptions({ transport: 'ws', ...options }),
    url: 'ws://127.0.0.1:9222/devtools/browser/test'
  })

  return { socket, transport }
}

class FakeChromeProcess implements ChromeProcessLike {
  readonly args: string[] = []
  readonly child = { pid: 101 } as ChildProcess
  readonly command = 'chrome'
  readonly readStream?: EventEmitter & Readable
  readonly stderr = new EventEmitter() as EventEmitter & Readable
  readonly writeStream?: FakeWriteStream & Writable
  readonly #events = new EventEmitter()
  isExited = false
  killCalls = 0
  lastError: Error | null = null
  state: 'running' | 'exited' = 'running'
  stdio: ChildProcess['stdio']

  constructor(stdio?: ChildProcess['stdio']) {
    if (stdio) {
      this.stdio = stdio

      return
    }

    this.readStream = new EventEmitter() as EventEmitter & Readable
    this.writeStream = new FakeWriteStream() as FakeWriteStream & Writable
    this.stdio = [null, null, this.stderr, this.writeStream, this.readStream] as ChildProcess['stdio']
  }

  on(event: 'exit', listener: (reason: string | null, error: Error | null) => void): this {
    this.#events.on(event, listener)

    return this
  }

  once(event: 'exit', listener: (reason: string | null, error: Error | null) => void): this {
    this.#events.once(event, listener)

    return this
  }

  removeListener(event: 'exit', listener: (reason: string | null, error: Error | null) => void): this {
    this.#events.removeListener(event, listener)

    return this
  }

  listenerCount(event: 'exit'): number {
    return this.#events.listenerCount(event)
  }

  emitExit(reason = 'Chrome process exited', error: Error | null = null): void {
    this.isExited = true
    this.state = 'exited'
    this.lastError = error
    this.#events.emit('exit', reason, error)
  }

  async kill(): Promise<void> {
    this.killCalls++

    if (!this.isExited) {
      this.emitExit('Chrome process killed')
    }
  }

  spawn(): void {}

  async waitForExit(): Promise<void> {
    if (!this.isExited) {
      throw new Error('Chrome exit timeout exceeded')
    }
  }
}

function createFakeChild(): EventEmitter & ChildProcess {
  return Object.assign(new EventEmitter(), { pid: 123, stdio: [] }) as unknown as EventEmitter & ChildProcess
}

function waitForImmediate(): Promise<void> {
  const { resolve, promise } = Promise.withResolvers<void>()

  setImmediate(resolve)

  return promise
}

test('PipeTransport emits complete NUL-delimited messages in order', async () => {
  const { readStream, transport } = createPipe()
  const messages: string[] = []

  transport.on('message', (message) => messages.push(message))

  readStream.emit('data', Buffer.from('{"id":1}\0{"id"'))
  readStream.emit('data', Buffer.from(':2}\0'))
  await waitForImmediate()

  assert.deepEqual(messages, ['{"id":1}', '{"id":2}'])
})

test('PipeTransport enforces outgoing, buffered, and incoming byte limits', async () => {
  const outgoing = createPipe({ maxMessageBytes: 3 })

  assert.throws(() => outgoing.transport.sendMessage('four'), /Message byte limit exceeded/)
  assert.equal(outgoing.transport.closed, true)

  const buffered = createPipe({ maxBufferedWriteBytes: 3 })

  buffered.writeStream.writableLength = 3
  assert.throws(() => buffered.transport.sendMessage('x'), /write buffer limit exceeded/)

  const incoming = createPipe({ maxMessageBytes: 3 })

  incoming.readStream.emit('data', Buffer.from('four'))
  await waitForImmediate()
  assert.equal(incoming.transport.closed, true)
  assert.equal(incoming.transport.frameByteLength, 0)
})

test('PipeTransport ignores EPIPE until close and releases all stream listeners', async () => {
  const { readStream, transport, writeStream } = createPipe()
  const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })

  writeStream.emit('error', error)
  assert.equal(transport.closed, false)
  writeStream.emit('close')
  await waitForImmediate()

  assert.equal(transport.closed, true)
  assert.equal(readStream.listenerCount('data'), 0)
  assert.equal(writeStream.listenerCount('error'), 0)
})

test('WebSocketTransport opens, sends, receives, and releases listeners', async () => {
  const { socket, transport } = createFakeWebSocketTransport()
  const messages: string[] = []

  transport.on('message', (message) => messages.push(message))
  const attaching = transport.attach()

  socket.open()
  await attaching

  transport.sendMessage('{"id":1}')
  socket.receive('{"id":1}')
  await waitForImmediate()

  assert.deepEqual(socket.sent, ['{"id":1}'])
  assert.deepEqual(messages, ['{"id":1}'])
  socket.peerClose()
  await waitForImmediate()
  assert.equal(getEventListeners(socket, 'message').length, 0)
})

test('WebSocketTransport fails closed on binary, oversized input, and write overflow', async () => {
  const binary = createFakeWebSocketTransport()
  const binaryAttach = binary.transport.attach()

  binary.socket.open()
  await binaryAttach
  binary.socket.receive('binary', true)
  assert.equal(binary.transport.closed, true)
  assert.equal(binary.socket.terminated, true)

  const oversized = createFakeWebSocketTransport({ maxMessageBytes: 3 })
  const oversizedAttach = oversized.transport.attach()

  oversized.socket.open()
  await oversizedAttach
  oversized.socket.receive('four')
  assert.equal(oversized.transport.closed, true)
  assert.equal(oversized.socket.terminated, true)

  const buffered = createFakeWebSocketTransport({ maxBufferedWriteBytes: 3 })
  const bufferedAttach = buffered.transport.attach()

  buffered.socket.open()
  await bufferedAttach
  buffered.socket.bufferedAmount = 3
  assert.throws(() => buffered.transport.sendMessage('x'), /write buffer limit exceeded/)
})

test('WebSocketTransport rejects pre-open failure and bounded attach timeout', async () => {
  for (const event of ['error', 'close']) {
    const { socket, transport } = createFakeWebSocketTransport()
    const attaching = transport.attach()

    if (event === 'error') {
      socket.fail(new Error('socket failed'))
    } else {
      socket.peerClose()
    }

    await assert.rejects(attaching)
    assert.equal(socket.terminated, true)
  }

  const timeout = createFakeWebSocketTransport({ attachTimeout: 0 })

  await assert.rejects(timeout.transport.attach(), /attach timeout exceeded/)
  assert.equal(timeout.socket.terminated, true)

  const cancelled = createFakeWebSocketTransport()
  const cancelledAttach = cancelled.transport.attach()

  cancelled.transport.close()
  await assert.rejects(cancelledAttach, /closed before attach/)
})

test('TaskQueue preserves order, batches work, and rejects overflow', async () => {
  const queue = new TaskQueue(128)
  const values: number[] = []

  for (let value = 0; value < 100; value++) {
    queue.enqueue(() => values.push(value))
  }

  await waitForImmediate()
  assert.deepEqual(
    values,
    Array.from({ length: 64 }, (_, index) => index)
  )
  await waitForImmediate()
  assert.equal(values.length, 100)

  const bounded = new TaskQueue(1)

  bounded.enqueue(() => {})
  assert.throws(() => bounded.enqueue(() => {}), /depth limit exceeded/)
  bounded.stop()

  const dropping = new TaskQueue(2, 'drop-oldest')
  const kept: string[] = []

  dropping.enqueue(() => kept.push('response'))
  dropping.enqueue(() => kept.push('old-event'), true)
  dropping.enqueue(() => kept.push('new-event'), true)
  await waitForImmediate()
  assert.deepEqual(kept, ['response', 'new-event'])
  assert.equal(dropping.droppedCount, 1)
})

test('canonicalizeOptions validates known options and environment values', () => {
  const options = normalizeOptions({ env: { A: '1', B: undefined }, transport: 'ws' })

  assert.equal(options.transport, 'ws')
  assert.equal(options.maxEndpointBytes, 64 * 1024)
  // @ts-expect-error Runtime validation rejects unknown options.
  assert.throws(() => normalizeOptions({ startTimeout: 1 }), /unknown option startTimeout/)
  // @ts-expect-error Runtime validation rejects non-string environment values.
  assert.throws(() => normalizeOptions({ env: { A: 1 } }), /A must be a string/)
  assert.throws(() => normalizeOptions({ maxEndpointBytes: 0 }), /positive safe integer/)
})

test('getSpawnEnv explicitly merges or replaces the parent environment', () => {
  assert.equal(getSpawnEnv(undefined), undefined)
  assert.equal(getSpawnEnv({ SWM_TEST: 'yes' })?.SWM_TEST, 'yes')
  assert.deepEqual(getSpawnEnv({ SWM_TEST: 'yes' }, false), { SWM_TEST: 'yes' })
})

test('ChromeProcess owns spawn state and emits a single terminal event', async () => {
  const child = createFakeChild()

  let spawnOptions: SpawnOptions | undefined

  const processOwner = new ChromeProcess({
    args: ['--headless'],
    command: 'chrome',
    createChild: (_command, _args, options) => {
      spawnOptions = options

      return child
    },
    options: transportOptions({ env: { A: '1' }, extendEnv: false })
  })
  const exits: (string | null)[] = []

  processOwner.on('exit', (reason) => exits.push(reason))
  processOwner.spawn()
  child.emit('exit', 0, null)
  child.emit('exit', 1, null)

  await processOwner.waitForExit()
  assert.equal(processOwner.state, 'exited')
  assert.equal(spawnOptions!.detached, process.platform !== 'win32')
  assert.deepEqual(spawnOptions!.env, { A: '1' })
  assert.equal(exits.length, 1)
})

test('ChromeProcess preserves spawn errors and waitForExit listener cleanup', async () => {
  const child = createFakeChild()
  const processOwner = new ChromeProcess({
    args: [],
    command: 'chrome',
    createChild: () => child,
    options: transportOptions()
  }).spawn()

  await assert.rejects(processOwner.waitForExit(0), /exit timeout exceeded/)
  assert.equal(processOwner.listenerCount('exit'), 0)
  const error = new Error('spawn failed')

  child.emit('error', error)
  await assert.rejects(processOwner.waitForExit(), (actual) => actual === error)
})

test('Windows process termination is asynchronous and bounded', async () => {
  let invocation:
    | {
        args: readonly string[]
        command: string
        options: { encoding: 'utf8'; maxBuffer: number; timeout: number; windowsHide: boolean }
      }
    | undefined

  await terminateWindowsProcess(123, 250, (command, args, options, callback) => {
    invocation = { args, command, options }
    setImmediate(() => callback(null, '', ''))
  })

  assert.equal(invocation!.command, 'taskkill')
  assert.deepEqual(invocation!.args, ['/pid', '123', '/T', '/F'])
  assert.equal(invocation!.options.timeout, 250)
  assert.equal(invocation!.options.windowsHide, true)
  await assert.rejects(terminateWindowsProcess(123, 0), /kill timeout exceeded/)
  await assert.rejects(
    terminateWindowsProcess(123, 250, (_command, _args, _options, callback) => {
      setImmediate(() => callback(new Error('taskkill failed'), '', 'access denied'))
    }),
    /access denied/
  )
})

test('ChromeProcess uses the bounded Windows process-tree terminator', async () => {
  const child = createFakeChild()

  let terminateCall: { pid: number; timeout: number } | undefined

  const processOwner = new ChromeProcess({
    args: [],
    command: 'chrome.exe',
    createChild: () => child,
    options: transportOptions(),
    platform: 'win32',
    async terminateWindows(pid, timeout) {
      terminateCall = { pid, timeout }
      child.emit('exit', null, 'SIGTERM')
    }
  }).spawn()

  await processOwner.kill(250)
  assert.equal(terminateCall!.pid, 123)
  assert.ok(terminateCall!.timeout > 0 && terminateCall!.timeout <= 250)
  assert.equal(processOwner.isExited, true)
})

test('WebSocketEndpoint captures chunked loopback URL and bounds stderr state', async () => {
  const chrome = new FakeChromeProcess()
  const endpoint = new WebSocketEndpoint(chrome, transportOptions({ maxEndpointBytes: 128 }))
  const waiting = endpoint.wait()

  chrome.stderr.emit('data', Buffer.from('noise\nDevTools listening on ws://127.0.0.1:9222/devtools/'))
  chrome.stderr.emit('data', Buffer.from('browser/id\r\n'))
  assert.equal(await waiting, 'ws://127.0.0.1:9222/devtools/browser/id')
  assert.equal(chrome.stderr.listenerCount('data'), 0)

  const overflowChrome = new FakeChromeProcess()
  const overflow = new WebSocketEndpoint(overflowChrome, transportOptions({ maxEndpointBytes: 3 }))

  overflowChrome.stderr.emit('data', Buffer.from('four'))
  await assert.rejects(overflow.wait(), /endpoint line limit exceeded/)
})

test('WebSocketEndpoint rejects non-loopback endpoints and early process exit', async () => {
  const remoteChrome = new FakeChromeProcess()
  const remote = new WebSocketEndpoint(remoteChrome, transportOptions())

  remoteChrome.stderr.emit('data', Buffer.from('DevTools listening on ws://example.com/devtools/browser/id\n'))
  await assert.rejects(remote.wait(), /must use ws:\/\/ on loopback/)

  const exitedChrome = new FakeChromeProcess()
  const exited = new WebSocketEndpoint(exitedChrome, transportOptions())

  exitedChrome.emitExit('startup failed', new Error('startup failed'))
  await assert.rejects(exited.wait(), /startup failed/)
})

test('Browser composes pipe transport, connection, process exit, and profile cleanup', async (t) => {
  const chrome = new FakeChromeProcess()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swm-cdp-browser-profile-test-'))
  const userDataDirectory = new UserDataDirectory({ userDataRoot: root })

  t.after(() => fs.rmSync(root, { force: true, recursive: true }))

  const browser = new Browser({
    chromeProcess: chrome,
    options: transportOptions(),
    userDataDirectory
  })

  assert.equal(browser.userDataDir, userDataDirectory.path)
  await browser.attach()
  assert.equal(browser.attached, true)
  assert.ok(browser.connection)
  assert.equal(typeof browser.transport!.sendMessage, 'function')
  chrome.emitExit()
  await waitForImmediate()
  assert.equal(browser.closed, true)
  assert.equal(browser.connection.closed, true)
  assert.equal(fs.existsSync(userDataDirectory.path), false)
})

test('Browser close is idempotent, requests graceful close, then avoids force kill', async () => {
  const chrome = new FakeChromeProcess()
  const browser = new Browser({
    chromeProcess: chrome,
    options: transportOptions()
  })

  await browser.attach()
  browser.transport!.on('message', () => chrome.emitExit())

  const closing = browser.close()
  const request = JSON.parse(Buffer.from(chrome.writeStream!.writes[0]!).toString('utf8').slice(0, -1)) as {
    id: number
    method: string
  }

  chrome.readStream!.emit('data', Buffer.from(`${JSON.stringify({ id: request.id, result: {} })}\0`))

  assert.equal(browser.close(), closing)
  assert.equal(browser.dispose(), closing)
  await closing
  assert.equal(request.method, 'Browser.close')
  assert.equal(chrome.killCalls, 0)
})

test('Browser attach failure force-kills Chrome and reaches terminal state', async () => {
  const chrome = new FakeChromeProcess([null, null] as unknown as ChildProcess['stdio'])
  const browser = new Browser({ chromeProcess: chrome, options: transportOptions() })

  await assert.rejects(browser.attach(), /debugging pipe is not available/)
  assert.equal(chrome.killCalls, 1)
  assert.equal(browser.transport!.closed, true)
  assert.equal(browser.closed, true)
})

test('Browser force-kills Chrome when its only transport closes unexpectedly', async () => {
  const chrome = new FakeChromeProcess()
  const browser = new Browser({ chromeProcess: chrome, options: transportOptions() })

  await browser.attach()

  browser.transport!.close(new Error('pipe failed'))
  await waitForImmediate()

  assert.equal(chrome.killCalls, 1)
  assert.equal(browser.closed, true)
  assert.match(browser.error!.message, /pipe failed/)
})

test('spawnChrome cleans an owned profile after synchronous spawn failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swm-cdp-spawn-test-'))

  try {
    assert.throws(() => spawnChrome({ chromeExecutable: '\0', userDataRoot: root }))
    assert.deepEqual(fs.readdirSync(root), [])
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('UserDataDirectory makes cleanup ownership explicit and idempotent', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swm-cdp-profile-test-'))
  const retainedPath = path.join(root, 'retained')
  const removablePath = path.join(root, 'removable')

  fs.mkdirSync(retainedPath)
  fs.mkdirSync(removablePath)
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))

  const temporary = new UserDataDirectory({ userDataRoot: root })

  assert.equal(temporary.created, true)
  assert.equal(fs.existsSync(temporary.path), true)
  temporary.cleanup()
  temporary.cleanup()
  assert.equal(fs.existsSync(temporary.path), false)

  const retained = new UserDataDirectory({ userDataDir: retainedPath })

  retained.cleanup()
  assert.equal(fs.existsSync(retainedPath), true)

  const removable = new UserDataDirectory({ cleanupUserDataDir: true, userDataDir: removablePath })

  removable.cleanup()
  assert.equal(fs.existsSync(removablePath), false)
})

test('getArguments builds deterministic pipe and loopback WebSocket flags', () => {
  const pipe = getArguments(
    normalizeOptions({
      additionalArguments: ['--disable-features=A', '--disable-features=B'],
      disableDefaultArguments: true,
      headless: true,
      transport: 'pipe',
      url: 'about:blank',
      userDataDir: '/tmp/profile'
    })
  )

  assert.ok(pipe.includes('--remote-debugging-pipe'))
  assert.ok(pipe.includes('--disable-features=A,B'))

  const websocket = getArguments(
    normalizeOptions({
      disableDefaultArguments: true,
      port: 0,
      transport: 'ws',
      userDataDir: '/tmp/profile'
    })
  )

  assert.ok(websocket.includes('--remote-debugging-port=0'))
  assert.ok(websocket.includes('--remote-debugging-address=127.0.0.1'))
})

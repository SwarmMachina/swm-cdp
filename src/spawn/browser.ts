import Connection from '../cdp/connection/connection.js'
import RemoteConnection from '../cdp/connection/remote-connection.js'
import PipeTransport from '../cdp/transport/pipe-transport.js'
import WebSocketTransport, { type CreateWebSocket } from '../cdp/transport/ws-transport.js'
import emitDiagnostic from '../diagnostics.js'
import EventRegistry, { type Unsubscribe } from '../events/event-registry.js'
import type {
  ChromeProcessLike,
  NormalizedLaunchOptions,
  ReadStreamLike,
  Transport,
  WriteStreamLike
} from '../types.js'
import WebSocketEndpoint from './websocket-endpoint.js'
import UserDataDirectory from './user-data-directory.js'

type BrowserState = 'created' | 'attaching' | 'open' | 'closing' | 'closed'
type BrowserEvents = {
  error: [error: Error]
  exit: [reason?: unknown]
}
type AttachableTransport = Transport & { attach(): void | Promise<void> }

interface BrowserOptions {
  chromeProcess: ChromeProcessLike
  createWebSocket?: CreateWebSocket
  options: NormalizedLaunchOptions
  userDataDirectory?: UserDataDirectory
}

/**
 * Owns a Chrome process and its CDP transport lifecycle.
 *
 * Instances are created by {@link spawnChrome}. Calling {@link Browser.attach}
 * establishes the protocol transport; calling {@link Browser.close} shuts down
 * both the connection and the owned Chrome process.
 * @remarks
 * A `Browser` is single-use. It can be attached and closed once. Repeated calls
 * to `attach()` or `close()` return the same in-flight promise.
 */
export class Browser {
  readonly #chromeProcess: ChromeProcessLike
  readonly #createWebSocket?: CreateWebSocket
  readonly #options: NormalizedLaunchOptions
  readonly #userDataDirectory: UserDataDirectory
  readonly #events = new EventRegistry<BrowserEvents>()
  readonly #endpoint: WebSocketEndpoint | null
  #state: BrowserState = 'created'
  #browserError: Error | null = null
  #transport: AttachableTransport | null = null
  #protocolConnection: Connection | null = null
  #connection: RemoteConnection | null = null
  #attachPromise: Promise<RemoteConnection> | null = null
  #closePromise: Promise<void> | null = null

  constructor({ chromeProcess, createWebSocket, options, userDataDirectory }: BrowserOptions) {
    this.#chromeProcess = chromeProcess
    this.#createWebSocket = createWebSocket
    this.#options = options
    this.#userDataDirectory = userDataDirectory ?? new UserDataDirectory(options)
    this.#endpoint = options.transport === 'ws' ? new WebSocketEndpoint(chromeProcess, options) : null
    chromeProcess.once('exit', this.#handleProcessExit)
  }

  /** Arguments passed to the Chrome process, excluding the executable. */
  get args(): string[] {
    return this.#chromeProcess.args
  }

  /** Whether the CDP transport is attached and open. */
  get attached(): boolean {
    return this.#state === 'open'
  }

  /** The underlying child-process handle. */
  get chromeProcess(): ChromeProcessLike['child'] {
    return this.#chromeProcess.child
  }

  /** Whether the browser lifecycle has reached its terminal state. */
  get closed(): boolean {
    return this.#state === 'closed'
  }

  /** The resolved Chrome executable path. */
  get command(): string {
    return this.#chromeProcess.command
  }

  /** The attached CDP client, or `null` before a successful {@link Browser.attach}. */
  get connection(): RemoteConnection | null {
    return this.#connection
  }

  /** The transport failure that initiated cleanup, if any. */
  get error(): Error | null {
    return this.#browserError
  }

  /** Whether the owned Chrome process has exited. */
  get isExited(): boolean {
    return this.#chromeProcess.isExited
  }

  /** The most recent process-management error, if any. */
  get lastError(): Error | null {
    return this.#chromeProcess.lastError
  }

  /** The Chrome process identifier, when the process has started. */
  get pid(): number | undefined {
    return this.#chromeProcess.pid
  }

  /** The current browser lifecycle state. */
  get state(): BrowserState {
    return this.#state
  }

  /** The active CDP transport, or `null` before attachment. */
  get transport(): AttachableTransport | null {
    return this.#transport
  }

  /** The Chrome user-data directory used by this process. */
  get userDataDir(): string {
    return this.#userDataDirectory.path
  }

  /** Returns the number of listeners registered for a lifecycle event. */
  listenerCount(event: keyof BrowserEvents): number {
    return this.#events.listenerCount(event)
  }

  /**
   * Registers a lifecycle event listener.
   *
   * The `error` event reports an unexpected transport failure. The `exit`
   * event reports process termination.
   * @returns A function that removes the listener.
   */
  on<Name extends keyof BrowserEvents>(event: Name, listener: (...args: BrowserEvents[Name]) => void): Unsubscribe {
    return this.#events.on(event, listener)
  }

  /**
   * Registers a one-shot lifecycle event listener.
   * @returns A function that removes the listener before it runs.
   */
  once<Name extends keyof BrowserEvents>(event: Name, listener: (...args: BrowserEvents[Name]) => void): Unsubscribe {
    return this.#events.once(event, listener)
  }

  /** Removes a lifecycle event listener. */
  removeListener<Name extends keyof BrowserEvents>(
    event: Name,
    listener: (...args: BrowserEvents[Name]) => void
  ): void {
    this.#events.off(event, listener)
  }

  /**
   * Establishes the configured CDP transport and returns its client.
   * @throws {Error} If Chrome exits, endpoint discovery fails, or the transport
   * cannot be attached. A failed attach also terminates the owned process.
   */
  attach(): Promise<RemoteConnection> {
    this.#attachPromise ??= this.#attachBrowser()

    return this.#attachPromise
  }

  /**
   * Gracefully closes Chrome, falling back to process termination at the
   * shutdown deadline.
   * @param timeout - Total graceful-shutdown budget in milliseconds. Defaults
   * to the `shutdownTimeout` supplied to {@link spawnChrome}.
   * @remarks This method is idempotent.
   */
  close(timeout = this.#options.shutdownTimeout): Promise<void> {
    this.#closePromise ??= this.#closeBrowser(timeout)

    return this.#closePromise
  }

  /** Alias for {@link Browser.close}, suitable for explicit disposal hooks. */
  dispose(timeout?: number): Promise<void> {
    return this.close(timeout)
  }

  /**
   * Terminates the owned Chrome process without sending `Browser.close`.
   * @param timeout - Process-termination budget in milliseconds.
   */
  kill(timeout?: number): Promise<void> {
    return this.#chromeProcess.kill(timeout)
  }

  /**
   * Waits for the owned Chrome process to exit.
   * @param timeout - Maximum wait in milliseconds. Defaults to 30 seconds.
   */
  waitForExit(timeout?: number): Promise<void> {
    return this.#chromeProcess.waitForExit(timeout)
  }

  async #attachBrowser(): Promise<RemoteConnection> {
    if (this.#state !== 'created') {
      throw new Error(`Browser cannot attach while ${this.#state}`)
    }

    this.#state = 'attaching'

    try {
      this.#transport = await this.#createTransport()
      this.#transport.once('close', this.#handleTransportClose)
      await this.#transport.attach()

      if (this.#chromeProcess.isExited) {
        throw this.#chromeProcess.lastError ?? new Error('Chrome exited during transport attach')
      }

      this.#protocolConnection = new Connection(this.#transport)
      this.#connection = new RemoteConnection(this.#protocolConnection, () => this.close())
      this.#state = 'open'

      return this.#connection
    } catch (error) {
      const attachError = normalizeError(error, 'Chrome attach failed')

      this.#transport?.close(attachError)
      this.#endpoint?.close()

      try {
        await this.#chromeProcess.kill(this.#options.shutdownTimeout)
      } catch (killError) {
        this.#state = 'closed'
        throw new AggregateError([attachError, killError], 'Chrome attach and cleanup failed', { cause: killError })
      }

      this.#state = 'closed'
      throw attachError
    }
  }

  async #createTransport(): Promise<AttachableTransport> {
    if (this.#options.transport === 'pipe') {
      return new PipeTransport({
        options: this.#options,
        readStream: (this.#chromeProcess.readStream ?? this.#chromeProcess.stdio?.[4]) as ReadStreamLike,
        writeStream: (this.#chromeProcess.writeStream ?? this.#chromeProcess.stdio?.[3]) as WriteStreamLike
      })
    }

    const url = await this.#endpoint!.wait()

    return new WebSocketTransport({
      createWebSocket: this.#createWebSocket,
      options: this.#options,
      url
    })
  }

  async #closeBrowser(timeout: number): Promise<void> {
    if (this.#state === 'closed') {
      return
    }

    this.#state = 'closing'
    const deadline = Date.now() + timeout

    if (!this.#chromeProcess.isExited && this.#protocolConnection && !this.#protocolConnection.closed) {
      try {
        const remaining = Math.max(0, deadline - Date.now())

        if (remaining > 0) {
          await this.#protocolConnection.send('Browser.close', undefined, undefined, { timeout: remaining })
        }
      } catch (error) {
        this.#debug('shutdown.browser-close-failed', error)
      }
    }

    if (!this.#chromeProcess.isExited) {
      try {
        const remaining = Math.max(0, deadline - Date.now())

        if (remaining <= 0) {
          throw new Error('Graceful shutdown deadline exceeded')
        }

        await this.#chromeProcess.waitForExit(remaining)
      } catch (error) {
        this.#debug('shutdown.graceful-failed', error)
        await this.#chromeProcess.kill(this.#options.shutdownTimeout)
      }
    }

    this.#endpoint?.close()
    this.#transport?.close()
    this.#state = 'closed'
  }

  readonly #handleProcessExit = (reason: string | null, error: Error | null): void => {
    const expected = this.#state === 'closing'

    this.#endpoint?.close()
    this.#transport?.close(expected ? undefined : (error ?? undefined))
    this.#state = 'closed'

    this.#userDataDirectory.cleanup()
    this.#events.emit('exit', reason)
  }

  readonly #handleTransportClose = (error?: Error): void => {
    if (this.#state !== 'open') {
      return
    }

    this.#browserError = error ?? new Error('CDP transport closed unexpectedly')
    this.#state = 'closing'
    this.#debug('transport.failed', this.#browserError)

    if (this.#events.listenerCount('error') > 0) {
      this.#events.emit('error', this.#browserError)
    }

    this.#startTransportCleanup()
  }

  #startTransportCleanup(): void {
    void this.#chromeProcess.kill(this.#options.shutdownTimeout).catch((killError: unknown) => {
      this.#browserError = new AggregateError(
        [this.#browserError, killError],
        'Transport failed and Chrome could not be killed'
      )
      this.#debug('transport.cleanup-failed', this.#browserError)

      if (this.#events.listenerCount('error') > 0) {
        this.#events.emit('error', this.#browserError)
      }
    })
  }

  #debug(event: string, data: unknown): void {
    if (this.#options.debugSpawn) {
      emitDiagnostic(this.#options.logger, 'debug', 'spawn', event, data)
    }
  }
}

export default Browser

function normalizeError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error })
}

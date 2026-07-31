import type Connection from './connection.js'

/**
 * Public client for one browser-level CDP connection.
 *
 * The facade exposes typed commands and events while keeping transport,
 * request-dispatcher, and flattened-session registries internal.
 */
export class RemoteConnection {
  /**
   * Subscribes to a typed CDP event.
   * @returns A function that removes the listener.
   */
  readonly on: Connection['on']

  /**
   * Waits for the next typed CDP event, or registers a one-shot listener.
   * @returns A promise when no listener is supplied; otherwise a function that
   * removes the listener.
   */
  readonly once: Connection['once']

  /**
   * Subscribes to connection closure outside the CDP event namespace.
   * @returns A function that removes the listener.
   */
  readonly onClose: Connection['onClose']

  /**
   * Subscribes to transport and protocol errors.
   * @returns A function that removes the listener.
   */
  readonly onError: Connection['onError']

  /**
   * Sends a typed CDP command.
   * @throws {CdpError} If Chrome returns a protocol error.
   * @throws {Error} If the operation is cancelled, times out, or the
   * connection closes.
   */
  readonly send: Connection['send']
  readonly #connection: Connection
  readonly #closeConnection: () => Promise<void>
  #closePromise: Promise<void> | null = null

  constructor(connection: Connection, closeConnection: () => Promise<void>) {
    this.#connection = connection
    this.#closeConnection = closeConnection

    this.on = this.#connection.on
    this.once = this.#connection.once
    this.onClose = this.#connection.onClose
    this.onError = this.#connection.onError
    this.send = this.#connection.send
  }

  /** Whether the underlying CDP connection has reached its terminal state. */
  get closed(): boolean {
    return this.#connection.closed
  }

  /**
   * Closes this client connection.
   * @returns The same Promise for every call.
   * @remarks A client returned by `connect()` closes only its WebSocket. A
   * client returned by {@link Browser.attach} delegates to the owning browser
   * and therefore also shuts down Chrome.
   */
  close(): Promise<void> {
    this.#closePromise ??= this.#closeConnection()

    return this.#closePromise
  }
}

export default RemoteConnection

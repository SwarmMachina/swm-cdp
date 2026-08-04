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
   * @param event Fully qualified CDP event name.
   * @param listener Function invoked with the event payload and optional
   * flattened-session ID.
   * @returns A function that removes the listener.
   */
  readonly on: Connection['on']

  /**
   * Waits for the next typed CDP event, or registers a one-shot listener.
   * @param event Fully qualified CDP event name.
   * @param listener Optional function invoked at most once.
   * @returns A promise when no listener is supplied; otherwise a function that
   * removes the listener.
   */
  readonly once: Connection['once']

  /**
   * Subscribes to connection closure outside the CDP event namespace.
   * @param listener Function invoked when the connection closes.
   * @returns A function that removes the listener.
   */
  readonly onClose: Connection['onClose']

  /**
   * Subscribes to transport and protocol errors.
   * @param listener Function invoked with the reported error.
   * @returns A function that removes the listener.
   */
  readonly onError: Connection['onError']

  /**
   * Sends a typed CDP command.
   * @param method Fully qualified CDP method name.
   * @param params Method parameters, when required by the command.
   * @param sessionIdOrOptions Flattened-session ID or per-command options.
   * @param options Per-command options when a session ID is supplied.
   * @returns The typed command result.
   * @throws {CdpError} If Chrome returns a protocol error.
   * @throws {Error} If the operation is cancelled, times out, or the
   * connection closes.
   */
  readonly send: Connection['send']
  readonly #connection: Connection
  readonly #closeConnection: () => Promise<void>
  #closePromise: Promise<void> | null = null

  /**
   * Creates a public facade around an internal protocol connection.
   * @internal
   */
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

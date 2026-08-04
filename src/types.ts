import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'

import type { Unsubscribe } from './events/event-registry.js'

/** Severity assigned to a structured {@link LogEntry}. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Runtime subsystem that produced a structured {@link LogEntry}. */
export type LogScope = 'spawn' | 'pipe' | 'ws' | 'protocol'

/** A structured runtime diagnostic record. */
export interface LogEntry {
  /** Optional event-specific payload. */
  data?: unknown

  /** Stable dot-separated event name. */
  event: string

  /** Event severity. */
  level: LogLevel

  /** Runtime subsystem that emitted the event. */
  scope: LogScope

  /** Unix timestamp in milliseconds. */
  time: number
}

/**
 * Receives structured runtime diagnostics.
 * @param entry Diagnostic record emitted by the runtime.
 */
export type LogSink = (entry: LogEntry) => void

/** Deadline and cancellation controls for one CDP operation. */
export interface OperationOptions {
  /** Signal that cancels the operation while it is pending. */
  signal?: AbortSignal

  /**
   * Operation deadline in milliseconds.
   * @default The connection's `protocolTimeout`.
   */
  timeout?: number
}

/** Options used by {@link spawnChrome}. */
export interface LaunchOptions {
  /** Extra command-line arguments appended after the built-in arguments. */
  additionalArguments?: string[]

  /**
   * Maximum time to complete a WebSocket handshake, in milliseconds.
   * @default `60_000`
   */
  attachTimeout?: number

  /** Path to a Chrome or Chromium executable. */
  chromeExecutable?: string

  /**
   * Whether to remove `userDataDir` after Chrome exits.
   * @default `false` for a caller-supplied directory. Automatically
   * created temporary profiles are always removed.
   */
  cleanupUserDataDir?: boolean

  /** Working directory inherited by the Chrome process. */
  cwd?: string

  /** Emit CDP request, response, and event diagnostics. */
  debugProtocol?: boolean

  /** Emit Chrome process lifecycle diagnostics. */
  debugSpawn?: boolean

  /** Emit transport lifecycle and message diagnostics. */
  debugTransport?: boolean

  /**
   * Disable the package's default Chrome flags.
   * @default `true`
   */
  disableDefaultArguments?: boolean

  /**
   * Behavior when the event queue reaches `maxQueueDepth`.
   *
   * `close` fails the transport. `drop-oldest` drops only ordinary CDP
   * notifications; responses and target lifecycle events are retained.
   * @default `'close'`
   */
  eventBackpressure?: 'close' | 'drop-oldest'

  /** Environment variables passed to Chrome. `undefined` removes a key. */
  env?: Record<string, string | undefined>

  /**
   * Whether `env` extends `process.env` instead of replacing it.
   * @default `true`
   */
  extendEnv?: boolean

  /**
   * Launch Chrome in headless mode.
   * @default `false`
   */
  headless?: boolean

  /** Receives structured runtime diagnostics. Defaults to `console`. */
  logger?: LogSink

  /**
   * Maximum queued outbound transport bytes.
   * @default `16_777_216` (16 MiB)
   */
  maxBufferedWriteBytes?: number

  /**
   * Maximum bytes accepted in the stderr line that reports a WebSocket
   * endpoint.
   * @default `65_536` (64 KiB)
   */
  maxEndpointBytes?: number

  /**
   * Maximum encoded size of one CDP message, in bytes.
   * @default `67_108_864` (64 MiB)
   * @remarks The built-in WebSocket reconstructs a message before this library
   * applies the limit. The endpoint is therefore restricted to loopback.
   */
  maxMessageBytes?: number

  /**
   * Maximum number of CDP commands waiting for responses.
   * @default `10_000`
   */
  maxPendingRequests?: number

  /**
   * Maximum number of queued transport tasks.
   * @default `10_000`
   */
  maxQueueDepth?: number

  /**
   * Loopback debugging port used by the WebSocket transport. `0` asks Chrome
   * to choose an available port.
   * @default `0`
   */
  port?: number

  /**
   * Default deadline for CDP commands and event waits, in milliseconds.
   * @default `180_000`
   */
  protocolTimeout?: number

  /**
   * Maximum graceful shutdown interval, in milliseconds.
   * @default `5_000`
   */
  shutdownTimeout?: number

  /**
   * Maximum time to wait for Chrome to report its WebSocket endpoint, in
   * milliseconds.
   * @default `10_000`
   */
  startupTimeout?: number

  /**
   * Chrome stdout and stderr mode.
   * @default `'ignore'`
   */
  stdio?: 'ignore' | 'inherit'

  /**
   * CDP transport
   * @default `'pipe'`
   */
  transport?: 'pipe' | 'ws'

  /** Initial URL opened by Chrome. */
  url?: string

  /** Existing Chrome profile directory. */
  userDataDir?: string

  /** Parent directory used for an automatically created temporary profile. */
  userDataRoot?: string
}

/** Options accepted when connecting to an already running local Chrome. */
export type ConnectOptions = Pick<
  LaunchOptions,
  | 'attachTimeout'
  | 'debugProtocol'
  | 'debugTransport'
  | 'eventBackpressure'
  | 'logger'
  | 'maxBufferedWriteBytes'
  | 'maxMessageBytes'
  | 'maxPendingRequests'
  | 'maxQueueDepth'
  | 'protocolTimeout'
>

/**
 * A local browser-level CDP WebSocket endpoint.
 *
 * Endpoint descriptions default to `127.0.0.1:9222` and are resolved through
 * Chrome's HTTP discovery API. URL targets must use `ws:` or `wss:` and the
 * exact host `127.0.0.1` or `[::1]`.
 */
export type ConnectTarget =
  | string
  | URL
  | {
      /** Complete browser-level CDP WebSocket URL. */
      url: string | URL
    }
  | {
      /** Numeric loopback discovery address. */
      host?: string

      /** Browser HTTP discovery port. */
      port?: number

      /** Whether to use HTTPS for endpoint discovery. */
      secure?: boolean
    }

/**
 * Canonical launch options used after validation and default resolution.
 * @internal
 */
export type NormalizedLaunchOptions = Required<
  Omit<
    LaunchOptions,
    | 'additionalArguments'
    | 'chromeExecutable'
    | 'cwd'
    | 'env'
    | 'logger'
    | 'transport'
    | 'url'
    | 'userDataDir'
    | 'userDataRoot'
  >
> &
  Pick<
    LaunchOptions,
    'additionalArguments' | 'chromeExecutable' | 'cwd' | 'env' | 'logger' | 'url' | 'userDataDir' | 'userDataRoot'
  > & {
    /** Selected CDP transport. */
    transport: 'pipe' | 'ws'
  }

/**
 * Minimal target metadata used by the flattened-session registry.
 * @internal
 */
export interface TargetInfo {
  /** Chrome target identifier. */
  targetId: string

  /** Additional target metadata supplied by Chrome. */
  [key: string]: unknown
}

/**
 * A session ID or target lookup used by the flattened-session registry.
 * @internal
 */
export type SessionIdentifier =
  | string
  | {
      /** Chrome session identifier. */
      sessionId?: string

      /** Chrome target identifier. */
      targetId?: string
    }

/** Metadata for a locally issued CDP request. */
export interface CdpRequest {
  /** Numeric request identifier assigned immediately before transport write. */
  id?: number

  /** Fully qualified CDP method name. */
  method: string

  /** Per-request deadline and cancellation controls. */
  options?: OperationOptions

  /** Method parameters sent to Chrome. */
  params?: object

  /** Flattened-session identifier, when the command targets a session. */
  sessionId?: string
}

/** Raw CDP response metadata retained by {@link CdpError}. */
export interface CdpResponse {
  /** Chrome protocol error, when the command failed. */
  error?: {
    /** Chrome protocol error code, when supplied. */
    code?: number

    /** Chrome protocol error details, when supplied. */
    data?: unknown

    /** Human-readable Chrome protocol error message. */
    message: string
  }

  /** Numeric identifier of the corresponding request. */
  id: number

  /** Original local request metadata, when retained by the dispatcher. */
  req?: CdpRequest

  /** Command result, when the command succeeded. */
  result?: unknown

  /** Flattened-session identifier, when the response belongs to a session. */
  sessionId?: string
}

/**
 * Raw CDP event metadata received from a transport.
 * @internal
 */
export interface CdpNotification {
  /** Fully qualified CDP event name. */
  method: string

  /** Event payload supplied by Chrome. */
  params?: Record<string, unknown>

  /** Flattened-session identifier, when the event belongs to a session. */
  sessionId?: string
}

/** Effective resource and diagnostic options used by a CDP transport. */
export interface TransportOptions extends LaunchOptions {
  /** Maximum queued outbound transport bytes. */
  maxBufferedWriteBytes: number

  /** Maximum encoded size of one CDP message, in bytes. */
  maxMessageBytes: number

  /** Maximum number of CDP commands waiting for responses. */
  maxPendingRequests: number

  /** Maximum number of queued transport tasks. */
  maxQueueDepth: number

  /** Default command and event-wait deadline, in milliseconds. */
  protocolTimeout: number
}

/** Active CDP message transport exposed by {@link Browser.transport}. */
export interface Transport {
  /** Whether the transport is attached and open. */
  readonly attached: boolean

  /** Whether transport attachment is in progress. */
  readonly attaching: boolean

  /** Whether the transport has reached its terminal state. */
  readonly closed: boolean

  /** Number of ordinary CDP events discarded by backpressure handling. */
  readonly droppedMessages: number

  /** Current transport lifecycle state. */
  readonly state: 'idle' | 'attaching' | 'open' | 'closed'

  /** Effective transport options. */
  options: TransportOptions

  /** Closes the transport and optionally reports its terminal error. */
  close(error?: Error): void

  /** Returns the number of listeners registered for a transport event. */
  listenerCount(event: 'message' | 'close'): number

  /** Subscribes to incoming CDP messages. */
  on(event: 'message', listener: (message: string) => void): Unsubscribe

  /** Subscribes to transport closure. */
  on(event: 'close', listener: (error?: Error) => void): Unsubscribe

  /** Registers a one-shot listener for an incoming CDP message. */
  once(event: 'message', listener: (message: string) => void): Unsubscribe

  /** Registers a one-shot listener for transport closure. */
  once(event: 'close', listener: (error?: Error) => void): Unsubscribe

  /** Removes an incoming-message listener. */
  removeListener(event: 'message', listener: (message: string) => void): void

  /** Removes a transport-close listener. */
  removeListener(event: 'close', listener: (error?: Error) => void): void

  /** Writes one encoded CDP message to the transport. */
  sendMessage(message: string): unknown
}

/**
 * Event methods shared by stream test doubles and Node.js streams.
 * @internal
 */
export type StreamEmitter = Pick<EventEmitter, 'on' | 'removeListener'> & {
  /** Whether the stream has been destroyed. */
  destroyed?: boolean
}

/**
 * Read-side stream contract required by the pipe transport.
 * @internal
 */
export type ReadStreamLike = StreamEmitter

/**
 * Write-side stream contract required by the pipe transport.
 * @internal
 */
export interface WriteStreamLike extends StreamEmitter {
  /** Bytes currently queued for writing. */
  writableLength?: number

  /** Ends the writable stream. */
  end(): void

  /** Writes a CDP pipe frame. */
  write(data: Uint8Array): boolean
}

/**
 * Process-owner contract consumed by {@link Browser}.
 * @internal
 */
export interface ChromeProcessLike {
  /** Arguments passed to Chrome, excluding the executable. */
  readonly args: string[]

  /** Underlying Node.js child-process handle. */
  readonly child: ChildProcess | null

  /** Resolved Chrome executable path. */
  readonly command: string

  /** Whether the Chrome process has exited. */
  readonly isExited: boolean

  /** Most recent process-management error, if any. */
  readonly lastError: Error | null

  /** Chrome process identifier, when available. */
  readonly pid?: number

  /** CDP pipe read stream, when configured. */
  readonly readStream?: Readable

  /** Chrome standard-error stream, when piped. */
  readonly stderr?: Readable | null

  /** Child-process standard streams. */
  readonly stdio?: ChildProcess['stdio']

  /** CDP pipe write stream, when configured. */
  readonly writeStream?: Writable

  /** Terminates the Chrome process within the supplied deadline. */
  kill(timeout?: number): Promise<void>

  /** Returns the number of registered process-exit listeners. */
  listenerCount(event: 'exit'): number

  /** Subscribes to process exit. */
  on(event: 'exit', listener: (reason: string | null, error: Error | null) => void): Unsubscribe | unknown

  /** Registers a one-shot process-exit listener. */
  once(event: 'exit', listener: (reason: string | null, error: Error | null) => void): Unsubscribe | unknown

  /** Removes a process-exit listener. */
  removeListener(event: 'exit', listener: (reason: string | null, error: Error | null) => void): unknown

  /** Starts the configured Chrome process. */
  spawn(): void

  /** Waits for the Chrome process to exit. */
  waitForExit(timeout?: number): Promise<void>
}

/**
 * Injectable child-process construction seam.
 * @internal
 */
export type CreateChildProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

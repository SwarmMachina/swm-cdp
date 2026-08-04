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
 * Object targets default to `127.0.0.1:9222`. URL targets must use `ws:` or
 * `wss:` and the exact host `127.0.0.1` or `[::1]`.
 */
export type ConnectTarget = string | URL | { url: string | URL } | { host?: string; port?: number; secure?: boolean }

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
    transport: 'pipe' | 'ws'
  }

export interface TargetInfo {
  targetId: string
  [key: string]: unknown
}

export type SessionIdentifier = string | { sessionId?: string; targetId?: string }

export interface CdpRequest {
  id?: number
  method: string
  options?: OperationOptions
  params?: object
  sessionId?: string
}

export interface CdpResponse {
  error?: { code?: number; data?: unknown; message: string }
  id: number
  req?: CdpRequest
  result?: unknown
  sessionId?: string
}

export interface CdpNotification {
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

export interface TransportOptions extends LaunchOptions {
  maxBufferedWriteBytes: number
  maxMessageBytes: number
  maxPendingRequests: number
  maxQueueDepth: number
  protocolTimeout: number
}

export interface Transport {
  readonly attached: boolean
  readonly attaching: boolean
  readonly closed: boolean
  readonly droppedMessages: number
  readonly state: 'idle' | 'attaching' | 'open' | 'closed'
  options: TransportOptions
  close(error?: Error): void
  listenerCount(event: 'message' | 'close'): number
  on(event: 'message', listener: (message: string) => void): Unsubscribe
  on(event: 'close', listener: (error?: Error) => void): Unsubscribe
  once(event: 'message', listener: (message: string) => void): Unsubscribe
  once(event: 'close', listener: (error?: Error) => void): Unsubscribe
  removeListener(event: 'message', listener: (message: string) => void): void
  removeListener(event: 'close', listener: (error?: Error) => void): void
  sendMessage(message: string): unknown
}

export type StreamEmitter = Pick<EventEmitter, 'on' | 'removeListener'> & { destroyed?: boolean }

export type ReadStreamLike = StreamEmitter

export interface WriteStreamLike extends StreamEmitter {
  writableLength?: number
  end(): void
  write(data: Uint8Array): boolean
}

export interface ChromeProcessLike {
  readonly args: string[]
  readonly child: ChildProcess | null
  readonly command: string
  readonly isExited: boolean
  readonly lastError: Error | null
  readonly pid?: number
  readonly readStream?: Readable
  readonly stderr?: Readable | null
  readonly stdio?: ChildProcess['stdio']
  readonly writeStream?: Writable
  kill(timeout?: number): Promise<void>
  listenerCount(event: 'exit'): number
  on(event: 'exit', listener: (reason: string | null, error: Error | null) => void): Unsubscribe | unknown
  once(event: 'exit', listener: (reason: string | null, error: Error | null) => void): Unsubscribe | unknown
  removeListener(event: 'exit', listener: (reason: string | null, error: Error | null) => void): unknown
  spawn(): void
  waitForExit(timeout?: number): Promise<void>
}

export type CreateChildProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

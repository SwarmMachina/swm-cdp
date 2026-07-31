import type { ConnectOptions, ConnectTarget, TransportOptions } from '../types.js'
import normalizeOptions from '../spawn/normalize-options.js'
import Connection from './connection/connection.js'
import RemoteConnection from './connection/remote-connection.js'
import WebSocketTransport, { type CreateWebSocket } from './transport/ws-transport.js'

const loopbackHosts = new Set(['127.0.0.1', '[::1]'])
const connectOptionKeys = new Set<keyof ConnectOptions>([
  'attachTimeout',
  'debugProtocol',
  'debugTransport',
  'eventBackpressure',
  'logger',
  'maxBufferedWriteBytes',
  'maxMessageBytes',
  'maxPendingRequests',
  'maxQueueDepth',
  'protocolTimeout'
])

/**
 * Connects to an existing browser-level CDP WebSocket endpoint on loopback.
 * @param target Endpoint URL or loopback host/port description.
 * @param options Transport, queue, logging, and operation limits.
 * @returns A client facade after the WebSocket handshake completes.
 * @throws {TypeError} If the target, protocol, host, or options are invalid.
 * @throws {Error} If the handshake fails or exceeds `attachTimeout`.
 * @remarks Only `127.0.0.1` and `[::1]` are accepted. Hostnames such as
 * `localhost` are intentionally rejected so the local-only boundary does not
 * depend on name resolution.
 * @example
 * ```ts
 * const cdp = await connect({ host: '127.0.0.1', port: 9222 })
 * const version = await cdp.send('Browser.getVersion')
 * await cdp.close()
 * ```
 */
export default function connect(target: ConnectTarget, options?: ConnectOptions): Promise<RemoteConnection> {
  return connectWith(target, options)
}

/** Injectable construction seam for transport tests. */
export async function connectWith(
  target: ConnectTarget,
  options?: ConnectOptions,
  createWebSocket?: CreateWebSocket
): Promise<RemoteConnection> {
  const endpoint = normalizeEndpoint(target)
  const normalizedOptions = canonicalizeConnectOptions(options)
  const transport = new WebSocketTransport({ createWebSocket, options: normalizedOptions, url: endpoint })
  const protocolConnection = new Connection(transport)
  const connection = new RemoteConnection(protocolConnection, async () => {
    if (protocolConnection.closed) {
      return
    }

    const closed = protocolConnection.once('close')

    transport.close()
    await closed
  })

  await transport.attach()

  return connection
}

function canonicalizeConnectOptions(options?: ConnectOptions): TransportOptions {
  if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
    throw new TypeError('options must be an object')
  }

  for (const key of Object.keys(options ?? {})) {
    if (!connectOptionKeys.has(key as keyof ConnectOptions)) {
      throw new TypeError(`unknown connect option ${key}`)
    }
  }

  return normalizeOptions({ ...options, transport: 'ws' }) as TransportOptions
}

function normalizeEndpoint(target: ConnectTarget): string {
  let value: string | URL

  if (typeof target === 'string' || target instanceof URL) {
    value = target
  } else if (target && typeof target === 'object' && 'url' in target) {
    value = target.url
  } else if (target && typeof target === 'object') {
    const host = target.host ?? '127.0.0.1'
    const port = target.port ?? 9222
    const protocol = target.secure ? 'wss:' : 'ws:'

    value = `${protocol}//${host}:${port}`
  } else {
    throw new TypeError('CDP endpoint must be a URL string, URL, or connection options')
  }

  let endpoint: URL

  try {
    endpoint = new URL(value)
  } catch (error) {
    throw new TypeError('CDP endpoint must be a valid URL', { cause: error })
  }

  if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
    throw new TypeError('CDP endpoint protocol must be ws: or wss:')
  }

  if (!loopbackHosts.has(endpoint.hostname)) {
    throw new TypeError(`CDP endpoint must use a loopback address, received ${endpoint.origin}`)
  }

  return endpoint.href
}

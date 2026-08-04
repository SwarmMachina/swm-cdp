import type { ConnectOptions, ConnectTarget, NormalizedLaunchOptions } from '../types.js'
import { version, type BrowserVersionInfo, type DiscoveryOptions, type DiscoveryTarget } from '../discovery.js'
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

interface EndpointDescription {
  host?: string
  port?: number
  secure?: boolean
}
type DiscoverBrowser = (target: DiscoveryTarget, options?: DiscoveryOptions) => Promise<BrowserVersionInfo>

/**
 * Connects to an existing browser-level CDP WebSocket endpoint on loopback.
 * @param target Endpoint URL or loopback host/port description.
 * @param options Transport, queue, logging, and operation limits.
 * @returns A client facade after endpoint discovery and the WebSocket
 * handshake complete.
 * @throws {TypeError} If the target, protocol, host, or options are invalid.
 * @throws {Error} If endpoint discovery or the handshake fails or exceeds
 * `attachTimeout`.
 * @remarks Only `127.0.0.1` and `[::1]` are accepted. Hostnames such as
 * `localhost` are intentionally rejected so the local-only boundary does not
 * depend on name resolution.
 * @example
 * ```time
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
  createWebSocket?: CreateWebSocket,
  discoverBrowser: DiscoverBrowser = version
): Promise<RemoteConnection> {
  const normalizedOptions = canonicalizeConnectOptions(options)
  const startedAt = Date.now()
  const description = isEndpointDescription(target)
  const endpoint = description
    ? await discoverEndpoint(target, normalizedOptions.attachTimeout, discoverBrowser)
    : normalizeEndpoint(target)
  const transportOptions = description ? withRemainingAttachTimeout(normalizedOptions, startedAt) : normalizedOptions
  const transport = new WebSocketTransport({ createWebSocket, options: transportOptions, url: endpoint })
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

async function discoverEndpoint(
  target: EndpointDescription,
  timeout: number,
  discoverBrowser: DiscoverBrowser
): Promise<string> {
  const description = normalizeEndpointDescription(target)
  const browser = await discoverBrowser(description, { timeout })

  if (typeof browser.webSocketDebuggerUrl !== 'string' || browser.webSocketDebuggerUrl.length === 0) {
    throw new Error('Chrome discovery did not provide a browser WebSocket endpoint')
  }

  return normalizeEndpoint(browser.webSocketDebuggerUrl)
}

function isEndpointDescription(target: ConnectTarget): target is EndpointDescription {
  return Boolean(target && typeof target === 'object' && !(target instanceof URL) && !('url' in target))
}

function normalizeEndpointDescription(target: EndpointDescription): Required<EndpointDescription> {
  const host = target.host ?? '127.0.0.1'
  const port = target.port ?? 9222
  const secure = target.secure ?? false

  if (typeof host !== 'string' || !loopbackHosts.has(host)) {
    throw new TypeError(`CDP endpoint must use a loopback address, received ${String(host)}`)
  }

  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('CDP endpoint port must be an integer between 0 and 65535')
  }

  if (typeof secure !== 'boolean') {
    throw new TypeError('CDP endpoint secure option must be a boolean')
  }

  return { host, port, secure }
}

function withRemainingAttachTimeout(options: NormalizedLaunchOptions, startedAt: number): NormalizedLaunchOptions {
  return {
    ...options,
    attachTimeout: Math.max(0, options.attachTimeout - (Date.now() - startedAt))
  }
}

function canonicalizeConnectOptions(options?: ConnectOptions): NormalizedLaunchOptions {
  if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
    throw new TypeError('options must be an object')
  }

  for (const key of Object.keys(options ?? {})) {
    if (!connectOptionKeys.has(key as keyof ConnectOptions)) {
      throw new TypeError(`unknown connect option ${key}`)
    }
  }

  return normalizeOptions({ ...options, transport: 'ws' })
}

function normalizeEndpoint(target: ConnectTarget): string {
  let value: string | URL

  if (typeof target === 'string' || target instanceof URL) {
    value = target
  } else if (target && typeof target === 'object' && 'url' in target) {
    value = target.url
  } else {
    throw new TypeError('CDP endpoint must be a complete WebSocket URL')
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

/** Chrome HTTP discovery endpoint. */
export type DiscoveryTarget = string | URL | { url: string | URL } | { host?: string; port?: number; secure?: boolean }

/** Resource limits for one Chrome discovery request. */
export interface DiscoveryOptions {
  /**
   * Maximum response body size, in bytes.
   * @default `8_388_608` (8 MiB)
   */
  maxResponseBytes?: number

  /**
   * Request deadline in milliseconds.
   * @default `10_000`
   */
  timeout?: number
}

/** Target metadata returned by Chrome's `/json/list` and `/json/new` endpoints. */
export interface DiscoveryTargetInfo {
  /** Chrome target identifier. */
  id: string

  /** Target kind, such as `page` or `service_worker`. */
  type: string

  /** Current target URL. */
  url: string

  /** Target-level CDP WebSocket URL, when exposed by Chrome. */
  webSocketDebuggerUrl?: string
  [key: string]: unknown
}

/** Browser metadata returned by Chrome's `/json/version` endpoint. */
export interface BrowserVersionInfo {
  /** Browser product and version string. */
  Browser: string

  /** Supported DevTools protocol version. */
  'Protocol-Version': string

  /** Browser-level CDP WebSocket URL, when exposed by Chrome. */
  webSocketDebuggerUrl?: string
  [key: string]: unknown
}

const defaultTarget = Object.freeze({ host: '127.0.0.1', port: 9222 })

/**
 * Lists debuggable Chrome targets.
 * @param target HTTP discovery endpoint. Object targets default to
 * `127.0.0.1:9222`.
 * @param options Response-size and timeout limits.
 * @returns Target metadata from `/json/list`.
 * @throws {TypeError} If the target is invalid.
 * @throws {RangeError} If the response exceeds `maxResponseBytes`.
 * @throws {Error} If the request times out, fails, returns a non-success
 * status, or contains invalid JSON.
 */
export function list(
  target: DiscoveryTarget = defaultTarget,
  options?: DiscoveryOptions
): Promise<DiscoveryTargetInfo[]> {
  return requestJson(target, '/json/list', 'GET', options)
}

/**
 * Reads browser and protocol version metadata.
 * @param target HTTP discovery endpoint. Object targets default to
 * `127.0.0.1:9222`.
 * @param options Response-size and timeout limits.
 * @returns Browser metadata from `/json/version`.
 * @throws {TypeError} If the target is invalid.
 * @throws {RangeError} If the response exceeds `maxResponseBytes`.
 * @throws {Error} If the request times out, fails, returns a non-success
 * status, or contains invalid JSON.
 */
export function version(
  target: DiscoveryTarget = defaultTarget,
  options?: DiscoveryOptions
): Promise<BrowserVersionInfo> {
  return requestJson(target, '/json/version', 'GET', options)
}

/**
 * Creates a new debuggable target.
 * @param target HTTP discovery endpoint.
 * @param url Initial target URL.
 * @param options Response-size and timeout limits.
 * @returns Metadata for the created target.
 * @throws {TypeError} If the target is invalid.
 * @throws {RangeError} If the response exceeds `maxResponseBytes`.
 * @throws {Error} If the request times out, fails, returns a non-success
 * status, or contains invalid JSON.
 */
export function createTarget(
  target: DiscoveryTarget = defaultTarget,
  url = 'about:blank',
  options?: DiscoveryOptions
): Promise<DiscoveryTargetInfo> {
  return requestJson(target, `/json/new?${encodeURIComponent(url)}`, 'PUT', options)
}

/**
 * Closes a debuggable target.
 * @param targetId Non-empty Chrome target identifier.
 * @param target HTTP discovery endpoint.
 * @param options Response-size and timeout limits.
 * @throws {TypeError} If `targetId` or the target is invalid.
 * @throws {RangeError} If the response exceeds `maxResponseBytes`.
 * @throws {Error} If the request times out, fails, or returns a non-success
 * status.
 */
export async function closeTarget(
  targetId: string,
  target: DiscoveryTarget = defaultTarget,
  options?: DiscoveryOptions
): Promise<void> {
  if (typeof targetId !== 'string' || targetId.length === 0) {
    throw new TypeError('targetId must be a non-empty string')
  }

  await request(target, `/json/close/${encodeURIComponent(targetId)}`, 'GET', options ?? {})
}

async function requestJson<Result>(
  target: DiscoveryTarget,
  pathname: string,
  method: 'GET' | 'PUT',
  options: DiscoveryOptions = {}
): Promise<Result> {
  const body = await request(target, pathname, method, options)

  try {
    return JSON.parse(body.toString('utf8')) as Result
  } catch (error) {
    throw new Error('Chrome discovery returned invalid JSON', { cause: error })
  }
}

async function request(
  target: DiscoveryTarget,
  pathname: string,
  method: 'GET' | 'PUT',
  options: DiscoveryOptions
): Promise<Buffer> {
  const base = normalizeBase(target)
  const url = new URL(pathname, base)
  const maximum = options.maxResponseBytes ?? 8 * 1024 * 1024
  const timeout = options.timeout ?? 10_000

  try {
    const response = await fetch(url, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout)
    })

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)

      throw new Error(`Chrome discovery request failed with HTTP ${response.status || 'unknown'}`)
    }

    if (!response.body) {
      return Buffer.alloc(0)
    }

    const chunks: Uint8Array[] = []

    let bytes = 0

    for await (const chunk of response.body) {
      bytes += chunk.byteLength

      if (bytes > maximum) {
        throw new RangeError(`Discovery response byte limit exceeded: ${maximum}`)
      }

      chunks.push(chunk)
    }

    return Buffer.concat(chunks, bytes)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error('Chrome discovery request timeout exceeded', { cause: error })
    }

    throw error
  }
}

function normalizeBase(target: DiscoveryTarget): URL {
  let value: string | URL

  if (typeof target === 'string' || target instanceof URL) {
    value = target
  } else if (target && typeof target === 'object' && 'url' in target) {
    value = target.url
  } else if (target && typeof target === 'object') {
    value = `${target.secure ? 'https' : 'http'}://${target.host ?? '127.0.0.1'}:${target.port ?? 9222}`
  } else {
    throw new TypeError('Discovery target must be a URL or connection options')
  }

  const base = new URL(value)

  if (base.protocol === 'ws:') {
    base.protocol = 'http:'
  } else if (base.protocol === 'wss:') {
    base.protocol = 'https:'
  }

  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new TypeError('Discovery endpoint protocol must be http:, https:, ws:, or wss:')
  }

  base.pathname = '/'
  base.search = ''
  base.hash = ''

  return base
}

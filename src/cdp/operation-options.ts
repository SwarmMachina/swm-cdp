import type { OperationOptions } from '../types.js'

interface ResolvedOperationOptions {
  signal?: AbortSignal
  timeout: number
}

export default function resolveOperationOptions(
  options: OperationOptions | undefined,
  defaultTimeout: number,
  operation: string
): ResolvedOperationOptions {
  if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
    throw new TypeError(`${operation} options must be an object`)
  }

  for (const key of Object.keys(options ?? {})) {
    if (key !== 'signal' && key !== 'timeout') {
      throw new TypeError(`${operation} options contain unknown key ${key}`)
    }
  }

  const { signal, timeout = defaultTimeout } = options ?? {}

  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError(`${operation} signal must be an AbortSignal`)
  }

  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new TypeError(`${operation} timeout must be a non-negative finite number`)
  }

  return { signal, timeout }
}

export function getAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason

  if (reason instanceof Error) {
    return reason
  }

  return new DOMException('The operation was aborted', 'AbortError')
}

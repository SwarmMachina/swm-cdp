import type { CdpRequest, CdpResponse, Transport } from '../types.js'
import resolveOperationOptions, { getAbortError } from './operation-options.js'
import CdpError from './cdp-error.js'

interface PendingRequest {
  abortHandler?: () => void
  reject(error: unknown): void
  request: CdpRequest & { id: number }
  resolve(response: CdpResponse): void
  signal?: AbortSignal
  timeoutId: NodeJS.Timeout
}

export class RequestDispatcher {
  readonly #transport: Transport
  readonly #timeout: number
  readonly #pending = new Map<number, PendingRequest>()
  readonly #maxPendingRequests: number
  #closed = false
  #lastRequestId = 0

  constructor(transport: Transport, timeout: number) {
    this.#transport = transport
    this.#timeout = timeout
    this.#maxPendingRequests = transport.options.maxPendingRequests ?? 10_000
  }

  get pendingCount(): number {
    return this.#pending.size
  }

  #getRequestId(): number {
    do {
      this.#lastRequestId = this.#lastRequestId >= Number.MAX_SAFE_INTEGER ? 1 : this.#lastRequestId + 1
    } while (this.#pending.has(this.#lastRequestId))

    return this.#lastRequestId
  }

  send(request: CdpRequest): Promise<CdpResponse> {
    if (this.#closed) {
      return Promise.reject(new CdpError(request, responseError(0, 'Transport already closed')))
    }

    if (this.#pending.size >= this.#maxPendingRequests) {
      return Promise.reject(new CdpError(request, responseError(0, 'Pending request limit exceeded')))
    }

    let operation

    try {
      operation = resolveOperationOptions(request.options, this.#timeout, 'Request')
    } catch (error) {
      return Promise.reject(error)
    }

    if (operation.signal?.aborted) {
      return Promise.reject(getAbortError(operation.signal))
    }

    const id = this.#getRequestId()
    const trackedRequest = { ...request, id }
    const { reject, resolve, promise } = Promise.withResolvers<CdpResponse>()
    const timeoutId = setTimeout(() => {
      this.resolve(responseError(id, 'Request timeout exceeded'))
    }, operation.timeout)

    const tracked: PendingRequest = {
      reject,
      request: trackedRequest,
      resolve,
      signal: operation.signal,
      timeoutId
    }

    this.#pending.set(id, tracked)

    if (operation.signal) {
      const signal = operation.signal

      tracked.abortHandler = () => this.#reject(id, getAbortError(signal))
      signal.addEventListener('abort', tracked.abortHandler, { once: true })
    }

    try {
      const { options: _localOptions, ...wireRequest } = trackedRequest

      this.#transport.sendMessage(JSON.stringify(wireRequest))
    } catch (error) {
      this.#reject(id, error)
    }

    return promise
  }

  resolve(response: CdpResponse): void {
    const tracked = this.#pending.get(response.id)

    if (!tracked) {
      return
    }

    this.#pending.delete(response.id)
    this.#cleanUp(tracked)
    response.req = tracked.request
    tracked.resolve(response)
  }

  #reject(id: number, error: unknown): void {
    const tracked = this.#pending.get(id)

    if (!tracked) {
      return
    }

    this.#pending.delete(id)
    this.#cleanUp(tracked)
    tracked.reject(error)
  }

  closeRequests(sessionId?: string): void {
    if (sessionId === undefined) {
      this.#closed = true
    }

    for (const tracked of this.#pending.values()) {
      if (sessionId === undefined || tracked.request.sessionId === sessionId) {
        this.resolve(
          responseError(tracked.request.id, `Session ${tracked.request.sessionId ?? 'browser'} already closed`)
        )
      }
    }
  }

  #cleanUp(tracked: PendingRequest): void {
    clearTimeout(tracked.timeoutId)

    if (tracked.signal && tracked.abortHandler) {
      tracked.signal.removeEventListener('abort', tracked.abortHandler)
    }
  }
}

export default RequestDispatcher

function responseError(id: number, message: string): CdpResponse {
  return { error: { message }, id }
}

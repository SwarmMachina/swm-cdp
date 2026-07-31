import EventRegistry from '../src/events/event-registry.js'
import type { CdpRequest, Transport, TransportOptions } from '../src/types.js'

interface LoopbackEvents {
  close: [error?: Error]
  message: [message: string]
}

export default class LoopbackTransport implements Transport {
  readonly attached = true
  readonly attaching = false
  readonly droppedMessages = 0
  readonly options: TransportOptions
  readonly #events = new EventRegistry<LoopbackEvents>()
  readonly listenerCount: Transport['listenerCount'] = this.#events.listenerCount
  readonly on: Transport['on'] = this.#events.on
  readonly once: Transport['once'] = this.#events.once
  readonly removeListener: Transport['removeListener'] = this.#events.off
  #closed = false

  constructor(maxPendingRequests: number) {
    this.options = {
      debugProtocol: false,
      maxBufferedWriteBytes: Number.MAX_SAFE_INTEGER,
      maxMessageBytes: Number.MAX_SAFE_INTEGER,
      maxPendingRequests,
      maxQueueDepth: Number.MAX_SAFE_INTEGER,
      protocolTimeout: 10_000
    }
  }

  get closed(): boolean {
    return this.#closed
  }

  get state(): Transport['state'] {
    return this.#closed ? 'closed' : 'open'
  }

  close(error?: Error): void {
    if (!this.#closed) {
      this.#closed = true
      this.#events.emit('close', error)
    }
  }

  sendMessage(message: string): void {
    const request = JSON.parse(message) as CdpRequest
    const response = JSON.stringify({
      id: request.id,
      result: { ok: true },
      sessionId: request.sessionId
    })

    queueMicrotask(() => this.#events.emit('message', response))
  }
}

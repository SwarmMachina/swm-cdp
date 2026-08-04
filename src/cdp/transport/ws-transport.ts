import type { Transport, TransportOptions } from '../../types.js'
import normalizeError from '../../error.js'
import TransportCore from './transport.js'

export type WebSocketLike = Pick<
  WebSocket,
  'addEventListener' | 'binaryType' | 'bufferedAmount' | 'close' | 'removeEventListener' | 'send'
>

interface WebSocketErrorEvent extends Event {
  readonly error?: unknown
  readonly message?: unknown
}

interface WebSocketMessageEvent extends Event {
  readonly data?: unknown
}

export type CreateWebSocket = (url: string) => WebSocketLike

interface WebSocketTransportOptions {
  createWebSocket?: CreateWebSocket
  options: TransportOptions
  url: string
}

export class WebSocketTransport implements Transport {
  readonly close: Transport['close']
  readonly listenerCount: Transport['listenerCount']
  readonly on: Transport['on']
  readonly once: Transport['once']
  readonly options: TransportOptions
  readonly removeListener: Transport['removeListener']
  readonly url: string
  readonly #createWebSocket: CreateWebSocket
  readonly #core: TransportCore
  #socket: WebSocketLike | null = null
  #listening = false
  #attachment: PromiseWithResolvers<void> | null = null
  #attachTimeout: ReturnType<typeof setTimeout> | null = null

  constructor({ createWebSocket = defaultCreateWebSocket, options, url }: WebSocketTransportOptions) {
    this.#createWebSocket = createWebSocket
    this.options = options
    this.url = url
    this.#core = new TransportCore({ closeIO: () => this.#closeIO(), options, scope: 'ws' })
    this.close = this.#core.close
    this.listenerCount = this.#core.listenerCount
    this.on = this.#core.on
    this.once = this.#core.once
    this.removeListener = this.#core.removeListener
  }

  get attached(): boolean {
    return this.#core.attached
  }

  get attaching(): boolean {
    return this.#core.attaching
  }

  get closed(): boolean {
    return this.#core.closed
  }

  get droppedMessages(): number {
    return this.#core.droppedMessages
  }

  get state(): Transport['state'] {
    return this.#core.state
  }

  attach(): Promise<void> {
    this.#core.beginAttach()
    const attachment = Promise.withResolvers<void>()

    this.#attachment = attachment

    try {
      this.#socket = this.#createWebSocket(this.url)
      this.#socket.binaryType = 'arraybuffer'
      this.#listening = true
      this.#socket.addEventListener('close', this.#onSocketClose)
      this.#socket.addEventListener('error', this.#onSocketError)
      this.#socket.addEventListener('message', this.#onSocketMessage)
      this.#socket.addEventListener('open', this.#onSocketOpen)
      this.#attachTimeout = setTimeout(() => {
        const error = new Error('WebSocket attach timeout exceeded')

        this.#settleAttachment(error)
        this.#core.close(error)
      }, this.options.attachTimeout)
    } catch (error) {
      const normalized = normalizeError(error, 'WebSocket attach failed')

      this.#settleAttachment(normalized)
      this.#core.close(normalized)
    }

    return attachment.promise
  }

  sendMessage(message: string): void {
    try {
      if (!this.#core.attached || !this.#socket) {
        throw new Error(this.#core.closed ? 'Transport already closed' : 'WebSocket transport is not attached')
      }

      const byteLength = this.#core.validateMessageSize(message)

      this.#core.validateWriteBuffer(this.#socket.bufferedAmount, byteLength)
      this.#core.debug('message.sent', message)
      this.#socket.send(message)
    } catch (error) {
      const normalized = normalizeError(error, 'WebSocket write failed')

      this.#core.close(normalized)
      throw normalized
    }
  }

  #closeIO(): void {
    if (this.#attachment) {
      this.#settleAttachment(new Error('WebSocket closed before attach'))
    }

    this.#detachSocket()

    try {
      this.#socket?.close()
    } catch (error) {
      this.#core.debug('close.failed', error)
    }
  }

  readonly #onSocketOpen = (): void => {
    try {
      this.#core.completeAttach()
      this.#settleAttachment()
    } catch (error) {
      const normalized = normalizeError(error, 'WebSocket attach failed')

      this.#settleAttachment(normalized)
      this.#core.close(normalized)
    }
  }

  readonly #onSocketClose = (): void => {
    const error = this.#core.attaching ? new Error('WebSocket closed before attach') : undefined

    if (error) {
      this.#settleAttachment(error)
    }

    this.#core.close(error)
  }

  readonly #onSocketError = (event: Event): void => {
    const detail = event as WebSocketErrorEvent
    const message =
      typeof detail.message === 'string' && detail.message ? detail.message : 'WebSocket connection failed'
    const error = detail.error instanceof Error ? detail.error : new Error(message)

    if (this.#core.attaching) {
      this.#settleAttachment(error)
    }

    this.#core.close(error)
  }

  readonly #onSocketMessage = (event: MessageEvent): void => {
    const { data } = event as WebSocketMessageEvent

    if (typeof data !== 'string') {
      this.#core.close(new TypeError('CDP WebSocket transport received a binary message'))

      return
    }

    try {
      this.#core.validateMessageSize(data)
      this.#core.enqueueMessage(data)
    } catch (error) {
      this.#core.close(normalizeError(error, 'WebSocket message validation failed'))
    }
  }

  #settleAttachment(error?: Error): void {
    this.#clearAttachTimeout()
    const attachment = this.#attachment

    this.#attachment = null

    if (error) {
      attachment?.reject(error)
    } else {
      attachment?.resolve()
    }
  }

  #clearAttachTimeout(): void {
    if (this.#attachTimeout) {
      clearTimeout(this.#attachTimeout)
    }

    this.#attachTimeout = null
  }

  #detachSocket(): void {
    if (!this.#socket || !this.#listening) {
      return
    }

    this.#socket.removeEventListener('close', this.#onSocketClose)
    this.#socket.removeEventListener('error', this.#onSocketError)
    this.#socket.removeEventListener('message', this.#onSocketMessage)
    this.#socket.removeEventListener('open', this.#onSocketOpen)
    this.#listening = false
  }
}

export default WebSocketTransport

function defaultCreateWebSocket(endpoint: string): WebSocketLike {
  return new WebSocket(endpoint)
}

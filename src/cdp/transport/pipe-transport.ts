import type { ReadStreamLike, Transport, TransportOptions, WriteStreamLike } from '../../types.js'
import normalizeError from '../../error.js'
import TransportCore from './transport.js'

interface PipeTransportOptions {
  options: TransportOptions
  readStream: ReadStreamLike
  writeStream: WriteStreamLike
}

export class PipeTransport implements Transport {
  readonly close: Transport['close']
  readonly listenerCount: Transport['listenerCount']
  readonly on: Transport['on']
  readonly once: Transport['once']
  readonly options: TransportOptions
  readonly removeListener: Transport['removeListener']
  readonly #readStream: ReadStreamLike
  readonly #writeStream: WriteStreamLike
  readonly #frameBuffers: Buffer[] = []
  readonly #core: TransportCore
  #frameByteLength = 0
  #frameStopped = false
  #listening = false

  constructor({ options, readStream, writeStream }: PipeTransportOptions) {
    this.options = options
    this.#readStream = readStream
    this.#writeStream = writeStream
    this.#core = new TransportCore({ closeIO: () => this.#closeIO(), options, scope: 'pipe' })
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

  get frameByteLength(): number {
    return this.#frameByteLength
  }

  get state(): Transport['state'] {
    return this.#core.state
  }

  attach(): void {
    this.#core.beginAttach()

    try {
      if (!this.#readStream?.on || !this.#writeStream?.on) {
        throw new Error('Chrome remote debugging pipe is not available')
      }

      this.#readStream.on('data', this.#onReadData)
      this.#readStream.on('end', this.#onReadEnd)
      this.#readStream.on('error', this.#onReadError)
      this.#writeStream.on('close', this.#onWriteClose)
      this.#writeStream.on('error', this.#onWriteError)
      this.#listening = true
      this.#core.completeAttach()
    } catch (error) {
      const normalized = normalizeError(error, 'Pipe attach failed')

      this.#core.close(normalized)
      throw normalized
    }
  }

  sendMessage(message: string): boolean {
    this.#core.debug('message.sent', message)

    try {
      if (!this.#core.attached || !this.#writeStream?.write) {
        throw new Error(this.#core.closed ? 'Transport already closed' : 'Pipe transport is not attached')
      }

      this.#core.validateMessageSize(message)
      const data = Buffer.from(`${message}\0`, 'utf8')

      this.#core.validateWriteBuffer(this.#writeStream.writableLength ?? 0, data.byteLength)

      return this.#writeStream.write(data)
    } catch (error) {
      const normalized = normalizeError(error, 'Pipe write failed')

      this.#core.close(normalized)
      throw normalized
    }
  }

  #closeIO(): void {
    this.#stopFrames()

    if (this.#listening) {
      this.#readStream.removeListener('data', this.#onReadData)
      this.#readStream.removeListener('end', this.#onReadEnd)
      this.#readStream.removeListener('error', this.#onReadError)
      this.#writeStream.removeListener('close', this.#onWriteClose)
      this.#writeStream.removeListener('error', this.#onWriteError)
      this.#listening = false
    }

    if (this.#writeStream && !this.#writeStream.destroyed) {
      try {
        this.#writeStream.end()
      } catch (error) {
        this.#core.debug('close.failed', error)
      }
    }
  }

  readonly #onReadData = (chunk: Buffer | Uint8Array | string): void => {
    try {
      this.#pushFrames(chunk)
    } catch (error) {
      this.#core.close(normalizeError(error, 'Pipe frame parsing failed'))
    }
  }

  readonly #onReadEnd = (): void => {
    try {
      this.#emitFrame()
      this.#core.close()
    } catch (error) {
      this.#core.close(normalizeError(error, 'Pipe ended with an incomplete frame'))
    }
  }

  readonly #onReadError = (error: Error): void => {
    this.#core.close(error)
  }

  readonly #onWriteClose = (): void => {
    this.#core.close()
  }

  readonly #onWriteError = (error: NodeJS.ErrnoException): void => {
    if (error.code !== 'EPIPE') {
      this.#core.close(error)
    }
  }

  #pushFrames(chunk: Buffer | Uint8Array | string): void {
    if (this.#frameStopped) {
      return
    }

    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)

    let start = 0

    for (let end = input.indexOf(0, start); end !== -1; end = input.indexOf(0, start)) {
      this.#appendFrame(input, start, end)
      this.#emitFrame()

      if (this.#frameStopped) {
        return
      }

      start = end + 1
    }

    this.#appendFrame(input, start, input.byteLength)
  }

  #appendFrame(chunk: Buffer, start: number, end: number): void {
    const length = end - start

    if (length === 0) {
      return
    }

    const maximum = this.options.maxMessageBytes ?? 64 * 1024 * 1024

    if (this.#frameByteLength + length > maximum) {
      throw new RangeError(`Message byte limit exceeded: ${maximum}`)
    }

    this.#frameBuffers.push(chunk.subarray(start, end))
    this.#frameByteLength += length
  }

  #emitFrame(): void {
    if (this.#frameByteLength === 0) {
      return
    }

    const frame =
      this.#frameBuffers.length === 1
        ? this.#frameBuffers[0]!
        : Buffer.concat(this.#frameBuffers, this.#frameByteLength)

    this.#clearFrame()
    this.#core.enqueueMessage(frame.toString('utf8'))
  }

  #stopFrames(): void {
    this.#frameStopped = true
    this.#clearFrame()
  }

  #clearFrame(): void {
    this.#frameBuffers.length = 0
    this.#frameByteLength = 0
  }
}

export default PipeTransport

import emitDiagnostic from '../../diagnostics.js'
import normalizeError from '../../error.js'
import EventRegistry, { type Unsubscribe } from '../../events/event-registry.js'
import type { LogScope, TransportOptions } from '../../types.js'
import scanCdpEnvelope from '../selective-json.js'
import isTargetLifecycleEvent from '../target-lifecycle.js'
import TaskQueue from './task-queue.js'

const MiB = 1024 * 1024

interface TransportEvents {
  close: [error?: Error]
  message: [message: string]
}

interface TransportCoreOptions {
  closeIO(): void
  options: TransportOptions
  scope: Extract<LogScope, 'pipe' | 'ws'>
}

export default class TransportCore {
  readonly #closeIO: () => void
  readonly #options: TransportOptions
  readonly #scope: Extract<LogScope, 'pipe' | 'ws'>
  readonly #events = new EventRegistry<TransportEvents>()
  readonly #dropEvents: boolean
  readonly #tasks: TaskQueue
  #state: 'idle' | 'attaching' | 'open' | 'closed' = 'idle'

  constructor({ closeIO, options, scope }: TransportCoreOptions) {
    this.#closeIO = closeIO
    this.#options = options
    this.#scope = scope
    this.#dropEvents = options.eventBackpressure === 'drop-oldest'
    this.#tasks = new TaskQueue(options.maxQueueDepth ?? 10_000, this.#dropEvents ? 'drop-oldest' : 'throw')

    this.close = this.close.bind(this)
    this.listenerCount = this.listenerCount.bind(this)
    this.on = this.on.bind(this)
    this.once = this.once.bind(this)
    this.removeListener = this.removeListener.bind(this)
  }

  get attached(): boolean {
    return this.#state === 'open'
  }

  get attaching(): boolean {
    return this.#state === 'attaching'
  }

  get closed(): boolean {
    return this.#state === 'closed'
  }

  get droppedMessages(): number {
    return this.#tasks.droppedCount
  }

  get state(): 'idle' | 'attaching' | 'open' | 'closed' {
    return this.#state
  }

  beginAttach(): void {
    if (this.#state === 'closed') {
      throw new Error('Transport already closed')
    }

    if (this.#state !== 'idle') {
      throw new Error(`Transport cannot attach while ${this.#state}`)
    }

    this.#state = 'attaching'
    this.debug('attach.started')
  }

  completeAttach(): void {
    if (this.#state !== 'attaching') {
      throw new Error(`Transport cannot open while ${this.#state}`)
    }

    this.#state = 'open'
    this.debug('attach.opened')
  }

  enqueueMessage(message: string): void {
    if (this.#state === 'closed') {
      return
    }

    this.debug('message.received', message)

    try {
      const accepted = this.#tasks.enqueue(
        () => {
          try {
            this.#events.emit('message', message)
          } catch (error) {
            this.close(normalizeError(error, 'Transport message handler failed'))
          }
        },
        this.#dropEvents && isDroppableNotification(message)
      )

      if (!accepted) {
        this.debug('message.dropped', { droppedMessages: this.#tasks.droppedCount })
      }
    } catch (error) {
      this.close(normalizeError(error, 'Transport queue failed'))
    }
  }

  close(error?: Error): void {
    if (this.#state === 'closed') {
      return
    }

    this.#state = 'closed'
    this.debug('transport.closed', error)
    this.#closeIO()

    if (error) {
      this.#tasks.stop()
      this.#events.emit('close', error)

      return
    }

    try {
      this.#tasks.enqueue(() => this.#events.emit('close'))
    } catch (queueError) {
      this.#tasks.stop()
      this.#events.emit('close', normalizeError(queueError, 'Transport close queue failed'))
    }
  }

  validateMessageSize(message: string): number {
    const messageBytes = Buffer.byteLength(message)
    const maximum = this.#options.maxMessageBytes ?? 64 * MiB

    if (messageBytes > maximum) {
      throw new RangeError(`Message byte limit exceeded: ${maximum}`)
    }

    return messageBytes
  }

  validateWriteBuffer(bufferedBytes: number, messageBytes: number): void {
    const maximum = this.#options.maxBufferedWriteBytes ?? 16 * MiB

    if (bufferedBytes + messageBytes > maximum) {
      throw new RangeError(`Transport write buffer limit exceeded: ${maximum}`)
    }
  }

  debug(event: string, data?: unknown): void {
    if (this.#options.debugTransport) {
      emitDiagnostic(this.#options.logger, 'debug', this.#scope, event, data)
    }
  }

  listenerCount(event: keyof TransportEvents): number {
    return this.#events.listenerCount(event)
  }

  on<Name extends keyof TransportEvents>(event: Name, listener: (...args: TransportEvents[Name]) => void): Unsubscribe {
    return this.#events.on(event, listener)
  }

  once<Name extends keyof TransportEvents>(
    event: Name,
    listener: (...args: TransportEvents[Name]) => void
  ): Unsubscribe {
    return this.#events.once(event, listener)
  }

  removeListener<Name extends keyof TransportEvents>(
    event: Name,
    listener: (...args: TransportEvents[Name]) => void
  ): void {
    this.#events.off(event, listener)
  }
}

function isDroppableNotification(message: string): boolean {
  const envelope = scanCdpEnvelope(message)

  return Boolean(envelope?.method && !isTargetLifecycleEvent(envelope.method))
}

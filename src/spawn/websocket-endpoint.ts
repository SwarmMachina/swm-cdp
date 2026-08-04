import { StringDecoder } from 'node:string_decoder'

import type { ChromeProcessLike, NormalizedLaunchOptions } from '../types.js'

const endpointPattern = /^(?:DevTools|Debugger) listening on (ws:\/\/[^\s]+)$/
const loopbackHosts = new Set(['127.0.0.1', '[::1]'])

interface EndpointWaiter {
  promise: Promise<string>
  reject(error: Error): void
  resolve(url: string): void
  timeoutId: ReturnType<typeof setTimeout>
}

export default class WebSocketEndpoint {
  readonly #chromeProcess: ChromeProcessLike
  readonly #options: NormalizedLaunchOptions
  readonly #decoder = new StringDecoder('utf8')

  #line = ''
  #url: string | null = null
  #error: Error | null = null
  #waiter: EndpointWaiter | null = null
  #stderrHandlers: { data: (chunk: Buffer | Uint8Array | string) => void; end: () => void } | null = null

  constructor(chromeProcess: ChromeProcessLike, options: NormalizedLaunchOptions) {
    this.#chromeProcess = chromeProcess
    this.#options = options
    chromeProcess.once('exit', this.#exitHandler)
    this.#observe()
  }

  get error(): Error | null {
    return this.#error
  }

  get url(): string | null {
    return this.#url
  }

  readonly #exitHandler = (reason: string | null, processError: Error | null): void => {
    this.#fail(
      processError ??
        new Error(typeof reason === 'string' ? reason : 'Chrome exited before exposing a debugging endpoint')
    )
  }

  wait(): Promise<string> {
    if (this.#url) {
      return Promise.resolve(this.#url)
    }

    if (this.#error) {
      return Promise.reject(this.#error)
    }

    if (this.#waiter) {
      return this.#waiter.promise
    }

    const { reject, resolve, promise } = Promise.withResolvers<string>()

    const waiter: EndpointWaiter = {
      promise,
      reject,
      resolve,
      timeoutId: setTimeout(() => {
        this.#waiter = null
        reject(new Error('Chrome debugging endpoint timeout exceeded'))
      }, this.#options.startupTimeout)
    }

    this.#waiter = waiter

    return promise
  }

  close(): void {
    this.#detach()
    this.#chromeProcess.removeListener('exit', this.#exitHandler)
  }

  #observe(): void {
    const stderr = this.#chromeProcess.stderr

    if (!stderr?.on) {
      this.#fail(new Error('Chrome stderr is unavailable for WebSocket endpoint discovery'))

      return
    }

    this.#stderrHandlers = {
      data: (chunk) => {
        if (this.#options.stdio === 'inherit') {
          process.stderr.write(chunk)
        }

        this.#consume(this.#decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      },
      end: () => {
        this.#consume(this.#decoder.end())
        this.#inspect(this.#line)

        if (!this.#url && !this.#error) {
          this.#fail(new Error('Chrome stderr ended before exposing a debugging endpoint'))
        }
      }
    }

    stderr.on('data', this.#stderrHandlers.data)
    stderr.once('end', this.#stderrHandlers.end)
  }

  #consume(text: string): void {
    if (this.#url || this.#error) {
      return
    }

    this.#line += text

    for (let lineEnd = this.#line.indexOf('\n'); lineEnd !== -1; lineEnd = this.#line.indexOf('\n')) {
      const candidate = this.#line.slice(0, lineEnd)

      this.#line = this.#line.slice(lineEnd + 1)

      if (Buffer.byteLength(candidate) > this.#options.maxEndpointBytes) {
        this.#fail(new RangeError(`Chrome endpoint line limit exceeded: ${this.#options.maxEndpointBytes}`))

        return
      }

      this.#inspect(candidate)

      if (this.#url || this.#error) {
        return
      }
    }

    if (Buffer.byteLength(this.#line) > this.#options.maxEndpointBytes) {
      this.#fail(new RangeError(`Chrome endpoint line limit exceeded: ${this.#options.maxEndpointBytes}`))
    }
  }

  #inspect(candidate: string): void {
    const normalized = candidate.endsWith('\r') ? candidate.slice(0, -1) : candidate
    const match = endpointPattern.exec(normalized)

    if (!match) {
      return
    }

    const rawEndpoint = match[1]!

    if (!URL.canParse(rawEndpoint)) {
      this.#fail(new TypeError(`Invalid Chrome debugging endpoint: ${rawEndpoint}`))

      return
    }

    const parsed = new URL(rawEndpoint)

    if (parsed.protocol !== 'ws:' || !loopbackHosts.has(parsed.hostname)) {
      this.#fail(new Error(`Chrome debugging endpoint must use ws:// on loopback, received ${parsed.origin}`))

      return
    }

    this.#url = parsed.href
    this.#settleSuccess(this.#url)
    this.close()
  }

  #fail(reason: Error): void {
    if (this.#url || this.#error) {
      return
    }

    this.#error = reason

    const waiter = this.#waiter

    if (waiter) {
      clearTimeout(waiter.timeoutId)
      waiter.reject(reason)
    }

    this.#waiter = null
    this.close()
  }

  #settleSuccess(value: string): void {
    const waiter = this.#waiter

    if (waiter) {
      clearTimeout(waiter.timeoutId)
      waiter.resolve(value)
    }

    this.#waiter = null
  }

  #detach(): void {
    if (!this.#stderrHandlers) {
      return
    }

    const stderr = this.#chromeProcess.stderr

    stderr?.removeListener?.('data', this.#stderrHandlers.data)
    stderr?.removeListener?.('end', this.#stderrHandlers.end)
    this.#stderrHandlers = null
  }
}

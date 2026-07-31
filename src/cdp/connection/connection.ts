import emitDiagnostic from '../../diagnostics.js'
import EventRegistry, { type Unsubscribe } from '../../events/event-registry.js'
import type ProtocolMapping from '../../generated/protocol-mapping.js'
import type {
  CdpNotification,
  CdpRequest,
  CdpResponse,
  OperationOptions,
  SessionIdentifier,
  TargetInfo,
  Transport
} from '../../types.js'
import CdpError from '../cdp-error.js'
import resolveOperationOptions from '../operation-options.js'
import scanCdpEnvelope from '../selective-json.js'
import RequestDispatcher from '../request-dispatcher.js'
import SessionAttachment from './session-attachment.js'
import SessionRegistry from './session-registry.js'

interface ConnectionEvents {
  [event: string]: [payload?: unknown, sessionId?: string]
}

interface ConnectionOptions {
  attachment?: SessionAttachment | null
  dispatcher?: RequestDispatcher
  sessionRegistry?: SessionRegistry
  timeout?: number
}

type CommandName = keyof ProtocolMapping.Commands
type EventName = keyof ProtocolMapping.Events
type CommandResult<Method extends CommandName> = ProtocolMapping.Commands[Method]['returnType']
type CommandTuple<Method extends CommandName> = ProtocolMapping.Commands[Method]['paramsType']
type First<Tuple extends unknown[]> = Tuple extends [] ? undefined : Tuple[0]
type CommandArguments<Method extends CommandName> =
  [] extends CommandTuple<Method>
    ? [params?: First<CommandTuple<Method>>, sessionIdOrOptions?: string | OperationOptions, options?: OperationOptions]
    : [params: First<CommandTuple<Method>>, sessionIdOrOptions?: string | OperationOptions, options?: OperationOptions]
type EventPayload<Event extends EventName> = ProtocolMapping.Events[Event] extends [infer Payload] ? Payload : undefined
type CustomMethod<Method extends string> = Method extends CommandName ? never : Method

/** Composes request, event, lifecycle and flattened-session capabilities. */
export class Connection {
  readonly #dispatcher: RequestDispatcher
  readonly #transport: Transport
  readonly #timeout: number
  readonly #sessionRegistry: SessionRegistry
  readonly #attachment: SessionAttachment | null
  readonly #events = new EventRegistry<ConnectionEvents>()
  readonly #pendingTargetAttachments = new Map<string, Promise<Connection>>()
  #detached = false
  #connectionError: Error | null = null
  #listeningToTransport = false

  constructor(transport: Transport, options: ConnectionOptions = {}) {
    this.#transport = transport
    this.#timeout = options.timeout ?? transport.options.protocolTimeout ?? 180_000
    this.#dispatcher = options.dispatcher ?? new RequestDispatcher(transport, this.#timeout)
    this.#sessionRegistry = options.sessionRegistry ?? new SessionRegistry()
    this.#attachment = options.attachment ?? null

    this.on = this.on.bind(this)
    this.once = this.once.bind(this)
    this.onClose = this.onClose.bind(this)
    this.onError = this.onError.bind(this)
    this.send = this.send.bind(this)
    this.onTransportMessage = this.onTransportMessage.bind(this)

    if (options.dispatcher === undefined) {
      transport.on('message', this.onTransportMessage)
      transport.on('close', this.#onTransportClose)
      this.#listeningToTransport = true
    }

    this.#protocolDebug('connection.created')
  }

  get closed(): boolean {
    return this.#detached
  }

  get error(): Error | null {
    return this.#connectionError
  }

  get pendingRequestCount(): number {
    return this.#dispatcher.pendingCount
  }

  get sessionId(): string | undefined {
    return this.#attachment?.sessionId
  }

  get targetId(): string | undefined {
    return this.#attachment?.targetId
  }

  get targetInfo(): TargetInfo | undefined {
    return this.#attachment?.targetInfo
  }

  listenerCount(event: string): number {
    return this.#events.listenerCount(event)
  }

  #isProtocolDebugEnabled(): boolean {
    return this.#transport.options.debugProtocol === true
  }

  #protocolDebug(event: string, data?: unknown): void {
    if (this.#isProtocolDebugEnabled()) {
      emitDiagnostic(this.#transport.options.logger, 'debug', 'protocol', event, data)
    }
  }

  #sendRequest(request: CdpRequest): Promise<CdpResponse> {
    const response = this.#dispatcher.send(request)

    this.#protocolDebug('request.sent', request)

    return response
  }

  onTransportMessage(message: string): void {
    this.#protocolDebug('message.received', message)

    try {
      const envelope = scanCdpEnvelope(message)

      if (envelope?.method && !this.#shouldParseNotification(envelope.method, envelope.sessionId)) {
        return
      }

      const payload: unknown = JSON.parse(message)

      if (!payload || typeof payload !== 'object') {
        return
      }

      if ('id' in payload && typeof payload.id === 'number') {
        this.#dispatcher.resolve(payload as CdpResponse)
      } else if ('method' in payload && typeof payload.method === 'string') {
        this.#dispatchNotification(payload as CdpNotification)
      }
    } catch (error) {
      const normalized = normalizeError(error, 'Dispatching message failed')

      this.#protocolDebug('message.dispatch-failed', normalized)
      this.#transport.close(normalized)
    }
  }

  #shouldParseNotification(method: string, sessionId?: string): boolean {
    if (isTargetLifecycleEvent(method) || this.#events.listenerCount(method) > 0) {
      return true
    }

    if (!sessionId) {
      return false
    }

    const sessionConnection = this.#sessionRegistry.getAttachment(sessionId)?.connection

    return (sessionConnection?.listenerCount(method) ?? 0) > 0
  }

  readonly #onTransportClose = (error?: Error): void => {
    if (this.#detached) {
      return
    }

    if (error) {
      this.#protocolDebug('transport.closed', error)
      this.#reportError(error)
    } else {
      this.#protocolDebug('transport.closed')
    }

    this.detach()
  }

  onError(listener: (error: Error) => void): Unsubscribe {
    return this.on<Error>('error', listener)
  }

  #reportError(error: Error): void {
    this.#connectionError = error

    if (this.#transport.options.logger || this.#isProtocolDebugEnabled()) {
      emitDiagnostic(this.#transport.options.logger, 'error', 'protocol', 'protocol.error', error)
    }

    if (this.#events.listenerCount('error') > 0) {
      this.#events.emit('error', error, this.sessionId)
    }
  }

  #dispatchNotification({ method, params, sessionId }: CdpNotification): void {
    if (sessionId) {
      const sessionConnection = this.getConnection({ sessionId })

      if (sessionConnection) {
        sessionConnection.#dispatchEvent(method, params)
      }

      try {
        this.#events.emit(method, params, sessionId)
      } catch (error) {
        this.#reportError(normalizeError(error, 'Error dispatching flattened session event'))
      }

      return
    }

    this.#dispatchEvent(method, params)
  }

  #dispatchEvent(method: string, params?: Record<string, unknown>): void {
    this.#debugEvent(method, params)

    try {
      if (method === 'Target.attachedToTarget') {
        this.#onAttachedToTarget(params)
      } else if (method === 'Target.detachedFromTarget') {
        this.#onDetachedFromTarget(params)
      } else if (method === 'Target.targetInfoChanged') {
        this.#onTargetInfoChanged(params)
      }

      this.#events.emit(method, params, this.sessionId)
    } catch (error) {
      this.#reportError(normalizeError(error, 'Error dispatching CDP event'))
    }
  }

  #onAttachedToTarget(params?: Record<string, unknown>): void {
    const sessionId = params?.sessionId
    const targetInfo = params?.targetInfo

    assertSessionId(sessionId)
    assertTargetInfo(targetInfo)

    const previousSessionId = this.#sessionRegistry.getSessionId(targetInfo)

    this.#sessionRegistry.attach(sessionId, targetInfo, this.sessionId)

    if (this.#isProtocolDebugEnabled()) {
      this.#protocolDebug('target.attached', {
        previousSessionId: previousSessionId === sessionId ? undefined : previousSessionId,
        sessionId,
        targetId: targetInfo.targetId
      })
    }
  }

  #onDetachedFromTarget(params?: Record<string, unknown>): void {
    const sessionId = params?.sessionId

    assertSessionId(sessionId)

    const targetAttachment = this.#sessionRegistry.getAttachment(sessionId)

    if (!targetAttachment) {
      return
    }

    this.#protocolDebug('target.detached', { sessionId, targetId: targetAttachment.targetId })
    this.#sessionRegistry.detach(sessionId)
  }

  #onTargetInfoChanged(params?: Record<string, unknown>): void {
    const targetInfo = params?.targetInfo

    assertTargetInfo(targetInfo)

    const targetAttachment = this.#sessionRegistry.updateTargetInfo(targetInfo)

    if (targetAttachment) {
      this.#protocolDebug('target.info-changed', { sessionId: targetAttachment.sessionId, targetInfo })
    }
  }

  #getSessionId(session: SessionIdentifier, throwIfNotAttached = false): string | undefined {
    const sessionId = this.#sessionRegistry.getSessionId(session, throwIfNotAttached)
    const targetAttachment = sessionId ? this.#sessionRegistry.getAttachment(sessionId) : undefined

    if (this.sessionId && targetAttachment?.parentSessionId !== this.sessionId) {
      if (throwIfNotAttached) {
        throw new Error(`Attachment ${sessionId} is not owned by session ${this.sessionId}.`)
      }

      return undefined
    }

    return sessionId
  }

  #getAttachment(session: SessionIdentifier, throwIfNotAttached = false): SessionAttachment | undefined {
    return this.#sessionRegistry.getAttachment(this.#getSessionId(session, throwIfNotAttached), throwIfNotAttached)
  }

  getConnection(session: SessionIdentifier, throwIfNotAttached: true): Connection
  getConnection(session: SessionIdentifier, throwIfNotAttached?: false): Connection | undefined
  getConnection(session: SessionIdentifier, throwIfNotAttached = false): Connection | undefined {
    const targetAttachment = this.#getAttachment(session, throwIfNotAttached)

    if (!targetAttachment) {
      return undefined
    }

    let connection = targetAttachment.connection

    if (!connection) {
      connection = new Connection(this.#transport, {
        attachment: targetAttachment,
        dispatcher: this.#dispatcher,
        sessionRegistry: this.#sessionRegistry,
        timeout: this.#timeout
      })

      targetAttachment.setConnection(connection)
    }

    return connection
  }

  async attachToTarget(target: string | TargetInfo): Promise<Connection> {
    const targetId = typeof target === 'string' ? target : target.targetId

    if (typeof targetId !== 'string' || targetId.length === 0) {
      throw new TypeError('Target id must be a non-empty string')
    }

    const known = this.getConnection({ targetId })

    if (known) {
      return known
    }

    const pending = this.#pendingTargetAttachments.get(targetId)

    if (pending) {
      return pending
    }

    const attaching = this.#attachTarget(targetId)

    this.#pendingTargetAttachments.set(targetId, attaching)

    try {
      return await attaching
    } finally {
      if (this.#pendingTargetAttachments.get(targetId) === attaching) {
        this.#pendingTargetAttachments.delete(targetId)
      }
    }
  }

  async #attachTarget(targetId: string): Promise<Connection> {
    const attached = await this.send<{ sessionId: string }>('Target.attachToTarget', { flatten: true, targetId })

    return this.getConnection(attached, true)
  }

  async setAutoAttach(autoAttach: boolean, waitForDebuggerOnStart = false): Promise<void> {
    await this.send('Target.setAutoAttach', { autoAttach, flatten: true, waitForDebuggerOnStart })
  }

  send<Method extends CommandName>(method: Method, ...args: CommandArguments<Method>): Promise<CommandResult<Method>>
  send<Result = unknown, Method extends string = string>(
    method: CustomMethod<Method>,
    params?: object,
    sessionIdOrOptions?: string | OperationOptions,
    options?: OperationOptions
  ): Promise<Result>
  async send<Result = unknown>(
    method: string,
    params?: object,
    sessionOrOptions?: string | OperationOptions,
    operationOptions?: OperationOptions
  ): Promise<Result> {
    if (this.#detached) {
      throw new Error(
        this.sessionId ? `Session ${this.sessionId} already detached` : 'Root connection already detached'
      )
    }

    if (typeof method !== 'string' || method.length === 0) {
      throw new TypeError('CDP method must be a non-empty string')
    }

    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
      throw new TypeError('CDP params must be an object')
    }

    const sessionId = typeof sessionOrOptions === 'string' ? sessionOrOptions : this.sessionId
    const requestOptions =
      typeof sessionOrOptions === 'string' ? operationOptions : (sessionOrOptions ?? operationOptions)
    const request: CdpRequest = { method, options: requestOptions, params, sessionId }
    const response = await this.#sendRequest(request)

    if (response.error) {
      throw new CdpError(response.req ?? request, response)
    }

    return response.result as Result
  }

  on<Event extends EventName>(
    event: Event,
    listener: (payload: EventPayload<Event>, sessionId?: string) => void
  ): Unsubscribe
  on<EventPayload = unknown>(event: string, listener: (payload: EventPayload, sessionId?: string) => void): Unsubscribe
  on<EventPayload = unknown>(
    event: string,
    listener: (payload: EventPayload, sessionId?: string) => void
  ): Unsubscribe {
    return this.#events.on(event, listener as (payload?: unknown, sessionId?: string) => void)
  }

  removeListener<EventPayload = unknown>(
    event: string,
    listener: (payload: EventPayload, sessionId?: string) => void
  ): void {
    this.#events.off(event, listener as (payload?: unknown, sessionId?: string) => void)
  }

  once<Event extends EventName>(event: Event): Promise<EventPayload<Event>>
  once<EventPayload = unknown>(event: string): Promise<EventPayload>
  once<EventPayload = unknown>(
    event: string,
    listener: (payload: EventPayload, sessionId?: string) => void
  ): Unsubscribe
  once<EventPayload = unknown>(
    event: string,
    listener?: (payload: EventPayload, sessionId?: string) => void
  ): Promise<EventPayload> | Unsubscribe {
    if (listener) {
      return this.#events.once(event, listener as (payload?: unknown, sessionId?: string) => void)
    }

    return this.until<EventPayload>(event)
  }

  until<EventPayload = unknown>(
    eventName: string,
    predicate?: (event: EventPayload) => boolean,
    operationOptions: OperationOptions = {}
  ): Promise<EventPayload> {
    if (typeof eventName !== 'string' || eventName.length === 0) {
      return Promise.reject(new TypeError('Event name must be a non-empty string'))
    }

    if (predicate !== undefined && typeof predicate !== 'function') {
      return Promise.reject(new TypeError('Event predicate must be a function'))
    }

    let operation

    try {
      operation = resolveOperationOptions(operationOptions, this.#timeout, 'Event wait')
    } catch (error) {
      return Promise.reject(error)
    }

    const { reject, resolve, promise } = Promise.withResolvers<EventPayload>()
    const timeoutMs = operation.timeout
    const signal = operation.signal

    let timeoutId: NodeJS.Timeout | undefined
    let unsubscribe = (): void => undefined

    const cleanUp = (): void => {
      unsubscribe()
      this.#events.off('close', onConnectionClose)
      signal?.removeEventListener('abort', onAbort)

      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
    const resolveEvent = (value: EventPayload): void => {
      cleanUp()
      resolve(value)
    }
    const rejectError = (error: Error): void => {
      cleanUp()
      reject(error)
    }
    const onConnectionClose = (): void => rejectError(new Error(`Connection closed while waiting for ${eventName}`))
    const onAbort = (): void =>
      rejectError(
        signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')
      )

    unsubscribe = this.on<EventPayload>(eventName, (event) => {
      try {
        if (!predicate || predicate(event)) {
          resolveEvent(event)
        }
      } catch (error) {
        rejectError(normalizeError(error, `Predicate for ${eventName} failed`))
      }
    })
    this.#events.on('close', onConnectionClose)
    signal?.addEventListener('abort', onAbort, { once: true })

    if (signal?.aborted) {
      onAbort()
    } else {
      timeoutId = setTimeout(() => rejectError(new Error(`Event wait timeout exceeded for ${eventName}`)), timeoutMs)
    }

    return promise
  }

  onClose(listener: () => void): Unsubscribe {
    return this.#events.on('close', listener)
  }

  detach(): void {
    if (this.#detached) {
      return
    }

    this.#clearSessions()
    this.#detached = true
    this.#protocolDebug('connection.detached')
    this.#dispatcher.closeRequests(this.sessionId)
    this.#cleanUpTransportListeners()
    this.#events.emit('close', undefined, this.sessionId)
  }

  #clearSessions(): void {
    if (this.sessionId) {
      this.#sessionRegistry.closeChildren(this.sessionId)
    } else {
      this.#sessionRegistry.clear()
    }
  }

  #debugEvent(method: string, params?: Record<string, unknown>): void {
    this.#protocolDebug(this.sessionId ? 'session.event' : 'root.event', {
      method,
      params,
      sessionId: this.sessionId
    })
  }

  #cleanUpTransportListeners(): void {
    if (!this.#listeningToTransport) {
      return
    }

    this.#transport.removeListener('message', this.onTransportMessage)
    this.#transport.removeListener('close', this.#onTransportClose)
    this.#listeningToTransport = false
  }
}

export default Connection

function normalizeError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error })
}

function assertSessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('Session id must be a non-empty string')
  }
}

function assertTargetInfo(value: unknown): asserts value is TargetInfo {
  if (!value || typeof value !== 'object' || !('targetId' in value) || typeof value.targetId !== 'string') {
    throw new TypeError('Target info must contain a non-empty target id')
  }
}

function isTargetLifecycleEvent(method: string): boolean {
  return (
    method === 'Target.attachedToTarget' ||
    method === 'Target.detachedFromTarget' ||
    method === 'Target.targetInfoChanged'
  )
}

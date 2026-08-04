import type { TargetInfo } from '../../types.js'
import type Connection from './connection.js'

export default class SessionAttachment {
  readonly parentSessionId?: string
  readonly sessionId: string
  readonly targetId: string
  #connection: Connection | null = null
  #targetInfo: TargetInfo

  constructor(sessionId: string, targetInfo: TargetInfo, parentSessionId?: string) {
    this.sessionId = sessionId
    this.targetId = targetInfo.targetId
    this.parentSessionId = parentSessionId
    this.#targetInfo = targetInfo
  }

  get connection(): Connection | null {
    return this.#connection
  }

  get targetInfo(): TargetInfo {
    return this.#targetInfo
  }

  setConnection(connection: Connection): void {
    if (this.#connection) {
      throw new Error(`Session ${this.sessionId} already has a connection`)
    }

    this.#connection = connection
  }

  updateTargetInfo(targetInfo: TargetInfo): void {
    this.#targetInfo = targetInfo
  }

  detach(): void {
    const connection = this.#connection

    this.#connection = null
    connection?.detach()
  }
}

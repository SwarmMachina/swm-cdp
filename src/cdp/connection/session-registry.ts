import type { SessionIdentifier, TargetInfo } from '../../types.js'
import SessionAttachment from './session-attachment.js'

export class SessionRegistry {
  readonly #attachmentsBySession = new Map<string, SessionAttachment>()
  readonly #childrenByParent = new Map<string, Set<string>>()
  readonly #sessionByTarget = new Map<string, string>()

  attach(sessionId: string, targetInfo: TargetInfo, parentSessionId?: string): void {
    assertSessionId(sessionId, 'Session id')
    assertTargetInfo(targetInfo)

    if (parentSessionId !== undefined) {
      assertSessionId(parentSessionId, 'Parent session id')
    }

    if (sessionId === parentSessionId) {
      throw new Error(`Session ${sessionId} cannot own itself`)
    }

    const targetId = targetInfo.targetId
    const existing = this.#attachmentsBySession.get(sessionId)

    if (existing) {
      if (existing.targetId !== targetId) {
        throw new Error(`Session ${sessionId} is already attached to target ${existing.targetId}`)
      }

      if (existing.parentSessionId !== parentSessionId) {
        throw new Error(`Session ${sessionId} is already attached to a different parent`)
      }

      existing.updateTargetInfo(targetInfo)

      return
    }

    const previousSessionId = this.#sessionByTarget.get(targetId)

    if (previousSessionId) {
      this.detach(previousSessionId)
    }

    const attachment = new SessionAttachment(sessionId, targetInfo, parentSessionId)

    this.#attachmentsBySession.set(sessionId, attachment)
    this.#sessionByTarget.set(targetId, sessionId)

    if (parentSessionId) {
      let children = this.#childrenByParent.get(parentSessionId)

      if (!children) {
        children = new Set<string>()
        this.#childrenByParent.set(parentSessionId, children)
      }

      children.add(sessionId)
    }
  }

  getSessionId(session: SessionIdentifier | undefined, throwIfNotAttached = false): string | undefined {
    if (typeof session === 'string') {
      return session
    }

    if (session && typeof session.sessionId === 'string') {
      return session.sessionId
    }

    if (session && typeof session.targetId === 'string') {
      const sessionId = this.#sessionByTarget.get(session.targetId)

      if (!sessionId && throwIfNotAttached) {
        throw new Error(`Target ${session.targetId} is not attached.`)
      }

      return sessionId
    }

    return undefined
  }

  getAttachment(session: SessionIdentifier | undefined, throwIfNotAttached = false): SessionAttachment | undefined {
    const sessionId = this.getSessionId(session, throwIfNotAttached)
    const attachment = sessionId ? this.#attachmentsBySession.get(sessionId) : undefined

    if (!attachment && throwIfNotAttached) {
      throw new Error(`Attachment ${sessionId} is no longer attached.`)
    }

    return attachment
  }

  updateTargetInfo(targetInfo: TargetInfo): SessionAttachment | undefined {
    const attachment = this.getAttachment(targetInfo)

    if (attachment) {
      attachment.updateTargetInfo(targetInfo)
    }

    return attachment
  }

  detach(sessionId: string): void {
    const attachment = this.#attachmentsBySession.get(sessionId)

    if (!attachment) {
      return
    }

    this.closeChildren(sessionId)
    this.#attachmentsBySession.delete(sessionId)

    if (this.#sessionByTarget.get(attachment.targetId) === sessionId) {
      this.#sessionByTarget.delete(attachment.targetId)
    }

    if (attachment.parentSessionId) {
      const siblings = this.#childrenByParent.get(attachment.parentSessionId)

      siblings?.delete(sessionId)

      if (siblings?.size === 0) {
        this.#childrenByParent.delete(attachment.parentSessionId)
      }
    }

    attachment.detach()
  }

  closeChildren(parentSessionId: string): void {
    const children = this.#childrenByParent.get(parentSessionId)

    if (!children) {
      return
    }

    this.#childrenByParent.delete(parentSessionId)

    for (const childSessionId of children) {
      this.detach(childSessionId)
    }
  }

  clear(): void {
    for (const sessionId of this.#attachmentsBySession.keys()) {
      this.detach(sessionId)
    }

    this.#attachmentsBySession.clear()
    this.#childrenByParent.clear()
    this.#sessionByTarget.clear()
  }
}

export default SessionRegistry

function assertSessionId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
}

function assertTargetInfo(value: unknown): asserts value is TargetInfo {
  if (!value || typeof value !== 'object' || !('targetId' in value) || typeof value.targetId !== 'string') {
    throw new TypeError('Target info must contain a non-empty target id')
  }

  if (value.targetId.length === 0) {
    throw new TypeError('Target info must contain a non-empty target id')
  }
}

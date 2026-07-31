import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import emitDiagnostic from '../diagnostics.js'
import canAccess from '../file-access.js'
import type { LaunchOptions } from '../types.js'

type UserDataDirectoryOptions = Pick<
  LaunchOptions,
  'cleanupUserDataDir' | 'debugSpawn' | 'logger' | 'userDataDir' | 'userDataRoot'
>

/** Owns the lifecycle of a Chrome user-data directory. */
export default class UserDataDirectory {
  readonly created: boolean
  readonly path: string
  readonly shouldCleanup: boolean
  readonly #cleanupPath: string
  readonly #options: UserDataDirectoryOptions

  #cleaned = false

  constructor(options: UserDataDirectoryOptions) {
    this.#options = options

    if (options.userDataDir) {
      this.created = false
      this.path = options.userDataDir
      this.#cleanupPath = path.resolve(this.path)
      this.shouldCleanup = options.cleanupUserDataDir === true

      return
    }

    const root = path.resolve(options.userDataRoot || os.tmpdir())

    if (!canAccess(root, 'rw')) {
      throw new Error(`Insufficient rights to create a user dir into root ${root}`)
    }

    this.created = true
    this.path = path.join(root, `swm-cdp-${randomUUID().replaceAll('-', '')}`)
    this.#cleanupPath = this.path
    this.shouldCleanup = true
    fs.mkdirSync(this.path, { mode: 0o700 })
  }

  cleanup(): void {
    if (!this.shouldCleanup || this.#cleaned) {
      return
    }

    this.#cleaned = true

    try {
      if (this.#options.debugSpawn) {
        emitDiagnostic(this.#options.logger, 'debug', 'spawn', 'profile.cleanup', this.path)
      }

      fs.rmSync(this.#cleanupPath, { force: true, maxRetries: 2, recursive: true, retryDelay: 100 })
    } catch (error) {
      if (this.#options.logger || this.#options.debugSpawn) {
        emitDiagnostic(this.#options.logger, 'error', 'spawn', 'profile.cleanup-failed', error)
      }
    }
  }
}

import { type ChildProcess, execFile, spawn as spawnChild, type SpawnOptions } from 'node:child_process'

import emitDiagnostic from '../diagnostics.js'
import normalizeError from '../error.js'
import EventRegistry from '../events/event-registry.js'
import type { CreateChildProcess, NormalizedLaunchOptions } from '../types.js'

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export function getSpawnEnv(
  env: Record<string, string | undefined> | undefined,
  extendEnv = true
): NodeJS.ProcessEnv | undefined {
  if (env === undefined) {
    return undefined
  }

  return extendEnv ? { ...process.env, ...env } : { ...env }
}

type ExecuteFile = (
  command: string,
  args: readonly string[],
  options: { encoding: 'utf8'; maxBuffer: number; timeout: number; windowsHide: boolean },
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => unknown

export function terminateWindowsProcess(pid: number, timeout: number, execute: ExecuteFile = execFile): Promise<void> {
  if (timeout <= 0) {
    return Promise.reject(new Error('Chrome kill timeout exceeded'))
  }

  const { reject, resolve, promise } = Promise.withResolvers<void>()

  try {
    execute(
      'taskkill',
      ['/pid', String(pid), '/T', '/F'],
      { encoding: 'utf8', maxBuffer: 64 * 1024, timeout, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message, { cause: error }))

          return
        }

        resolve()
      }
    )
  } catch (error) {
    reject(error)
  }

  return promise
}

type ExitReason = string | null
type ProcessEvents = { exit: [reason: ExitReason, error: Error | null] }
type KillProcess = (pid: number, signal: NodeJS.Signals) => true
type TerminateWindows = (pid: number, timeout: number) => Promise<void>

export interface ChromeProcessOptions {
  args: string[]
  command: string
  createChild?: CreateChildProcess
  killProcess?: KillProcess
  options: NormalizedLaunchOptions
  platform?: NodeJS.Platform
  terminateWindows?: TerminateWindows
}

export class ChromeProcess {
  readonly args: string[]
  readonly command: string
  readonly #createChild: CreateChildProcess
  readonly #killProcess: KillProcess
  readonly #options: NormalizedLaunchOptions
  readonly #platform: NodeJS.Platform
  readonly #terminateWindows: TerminateWindows
  readonly #events = new EventRegistry<ProcessEvents>()
  #child: ChildProcess | null = null
  #childHandlers: {
    error: (error: Error) => void
    exit: (code: number | null, signal: NodeJS.Signals | null) => void
  } | null = null
  #state: 'idle' | 'running' | 'exited' = 'idle'
  #lastError: Error | null = null
  #exitReason: ExitReason = null
  #killPromise: Promise<void> | null = null

  constructor({
    args,
    command,
    createChild = spawnChild,
    killProcess = process.kill,
    options,
    platform = process.platform,
    terminateWindows = terminateWindowsProcess
  }: ChromeProcessOptions) {
    this.args = args
    this.command = command
    this.#createChild = createChild
    this.#killProcess = killProcess
    this.#options = options
    this.#platform = platform
    this.#terminateWindows = terminateWindows
  }

  get child(): ChildProcess | null {
    return this.#child
  }

  get isExited(): boolean {
    return this.#state === 'exited'
  }

  get lastError(): Error | null {
    return this.#lastError
  }

  get pid(): number | undefined {
    return this.#child?.pid
  }

  get state(): 'idle' | 'running' | 'exited' {
    return this.#state
  }

  get stderr(): ChildProcess['stderr'] | undefined {
    return this.#child?.stderr
  }

  get stdio(): ChildProcess['stdio'] | undefined {
    return this.#child?.stdio
  }

  listenerCount(event: 'exit'): number {
    return this.#events.listenerCount(event)
  }

  on(event: 'exit', listener: (...args: ProcessEvents['exit']) => void): () => void {
    return this.#events.on(event, listener)
  }

  once(event: 'exit', listener: (...args: ProcessEvents['exit']) => void): () => void {
    return this.#events.once(event, listener)
  }

  removeListener(event: 'exit', listener: (...args: ProcessEvents['exit']) => void): void {
    this.#events.off(event, listener)
  }

  spawn(): ChromeProcess {
    if (this.#state !== 'idle') {
      throw new Error(`Chrome process cannot spawn while ${this.#state}`)
    }

    const { cwd, env, extendEnv, stdio: stdioMode } = this.#options
    const stdio: SpawnOptions['stdio'] =
      this.#options.transport === 'pipe'
        ? [stdioMode, stdioMode, stdioMode, 'pipe', 'pipe']
        : [stdioMode, stdioMode, 'pipe']

    this.#child = this.#createChild(this.command, this.args, {
      cwd,
      detached: this.#platform !== 'win32',
      env: getSpawnEnv(env, extendEnv),
      stdio
    })

    this.#state = 'running'

    this.#childHandlers = {
      error: (error) => this.#finish(error),
      exit: (code, signal) => this.#finish(null, code, signal)
    }
    this.#child.once('error', this.#childHandlers.error)
    this.#child.once('exit', this.#childHandlers.exit)
    this.#debug('process.spawn', {
      args: this.args,
      command: this.command,
      options: { cwd, extendEnv, hasCustomEnv: env !== undefined, stdio },
      pid: this.#child.pid
    })

    return this
  }

  waitForExit(timeout = 30_000): Promise<void> {
    if (this.#state === 'exited') {
      return this.#lastError ? Promise.reject(this.#lastError) : Promise.resolve()
    }

    if (!this.#child) {
      return Promise.reject(new Error('Chrome process has not started'))
    }

    const { reject, resolve, promise } = Promise.withResolvers<void>()

    const cleanup = () => {
      clearTimeout(timeoutId)
      this.#events.off('exit', onExit)
    }

    const onExit = (_reason: ExitReason, error: Error | null) => {
      cleanup()

      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    const timeoutId = setTimeout(() => {
      cleanup()
      reject(new Error('Chrome exit timeout exceeded'))
    }, timeout)

    this.#events.once('exit', onExit)

    return promise
  }

  kill(timeout = 5_000): Promise<void> {
    this.#killPromise ??= this.#forceKill(timeout)

    return this.#killPromise
  }

  async #forceKill(timeout: number): Promise<void> {
    if (!this.#child || this.#state === 'exited') {
      return
    }

    this.#debug('process.force-kill', { pid: this.#child.pid })
    const deadline = Date.now() + timeout

    try {
      if (this.#platform === 'win32' && this.#child.pid !== undefined) {
        await this.#terminateWindows(this.#child.pid, Math.max(0, deadline - Date.now()))
      } else if (this.#child.pid !== undefined) {
        try {
          this.#killProcess(-this.#child.pid, 'SIGKILL')
        } catch (error) {
          if (!isErrnoException(error) || error.code !== 'ESRCH') {
            throw error
          }
        }
      }

      await this.waitForExit(Math.max(0, deadline - Date.now()))
    } catch (error) {
      if (!this.isExited) {
        const normalized = normalizeError(error, 'Unexpected process error')

        throw new Error(`Chrome could not be killed: ${normalized.message}`, { cause: error })
      }
    }
  }

  #finish(error: Error | null, code: number | null = null, signal: NodeJS.Signals | null = null): void {
    if (this.#state === 'exited') {
      return
    }

    this.#exitReason = error
      ? `Chrome process failed: ${error.message}`
      : `Chrome process exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}`
    this.#state = 'exited'
    this.#lastError =
      error ?? ((code !== null && code !== 0) || signal ? new Error(this.#exitReason ?? 'Chrome exited') : null)

    this.#detachChildHandlers()
    this.#debug(this.#lastError ? 'process.error' : 'process.exit', {
      code,
      error: this.#lastError,
      pid: this.#child?.pid,
      signal
    })
    this.#events.emit('exit', this.#exitReason, this.#lastError)
  }

  #detachChildHandlers(): void {
    if (!this.#childHandlers) {
      return
    }

    this.#child?.removeListener('error', this.#childHandlers.error)
    this.#child?.removeListener('exit', this.#childHandlers.exit)
    this.#childHandlers = null
  }

  #debug(event: string, data: unknown): void {
    if (this.#options.debugSpawn) {
      emitDiagnostic(this.#options.logger, 'debug', 'spawn', event, data)
    }
  }
}

export default ChromeProcess

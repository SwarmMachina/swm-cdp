import emitDiagnostic from '../diagnostics.js'
import findChrome from '../finder.js'
import Browser from './browser.js'
import normalizeOptions from './normalize-options.js'
import ChromeProcess from './chrome-process.js'
import getArguments from './get-arguments.js'
import UserDataDirectory from './user-data-directory.js'
import type { LaunchOptions, NormalizedLaunchOptions } from '../types.js'

function debug(options: NormalizedLaunchOptions, event: string, data: unknown): void {
  if (options.debugSpawn) {
    emitDiagnostic(options.logger, 'debug', 'spawn', event, data)
  }
}

function freezeOptions(options: NormalizedLaunchOptions): void {
  if (options.additionalArguments) {
    Object.freeze(options.additionalArguments)
  }

  if (options.env) {
    Object.freeze(options.env)
  }

  Object.freeze(options)
}

/**
 * Starts an owned Chrome process.
 * @param options Executable, profile, transport, resource, and logging options.
 * @returns A lifecycle owner. Call {@link Browser.attach} to wait for CDP
 * readiness and obtain a client.
 * @throws {TypeError} If an option is invalid.
 * @throws {Error} If Chrome cannot be found or the process cannot be started.
 * @remarks Process creation is synchronous from the caller's perspective;
 * protocol readiness is an explicit asynchronous stage.
 * @example
 * ```time
 * const browser = spawnChrome({ headless: true })
 * const cdp = await browser.attach()
 * await cdp.send('Browser.getVersion')
 * await browser.close()
 * ```
 */
export default function spawnChrome(options?: LaunchOptions): Browser {
  const launchOptions = normalizeOptions(options)

  if (!launchOptions.chromeExecutable) {
    launchOptions.chromeExecutable = findChrome()
    debug(launchOptions, 'executable.found', launchOptions.chromeExecutable)
  }

  const userDataDirectory = new UserDataDirectory(launchOptions)

  launchOptions.userDataDir = userDataDirectory.path
  launchOptions.cleanupUserDataDir = userDataDirectory.shouldCleanup

  if (userDataDirectory.created) {
    debug(launchOptions, 'profile.created', launchOptions.userDataDir)
  }

  freezeOptions(launchOptions)
  const args = getArguments(launchOptions)

  debug(launchOptions, 'arguments.resolved', args)

  const chromeProcess = new ChromeProcess({
    args,
    command: launchOptions.chromeExecutable!,
    options: launchOptions
  })

  try {
    chromeProcess.spawn()

    return new Browser({ chromeProcess, options: launchOptions, userDataDirectory })
  } catch (error) {
    userDataDirectory.cleanup()
    throw error
  }
}

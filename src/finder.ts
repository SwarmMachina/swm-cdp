import ChromeFinder from './finder/find-chrome.js'

export { ChromeFinder }
export { ChromeNotInstalledError, ErrorCodes, FinderError, UnsupportedPlatformError } from './finder/finder-errors.js'

const chromeFinder = new ChromeFinder()

/**
 * Finds an installed Chrome or Chromium executable for the current platform.
 * @returns The absolute path to the selected executable.
 * @throws {ChromeNotInstalledError} If no accessible installation is found.
 * @throws {UnsupportedPlatformError} If the current platform is unsupported.
 */
export function findChrome(): string {
  return chromeFinder.find()
}

export default findChrome

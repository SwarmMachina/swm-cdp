import getPlatform from './platforms/get-platform.js'

export const ErrorCodes = {
  ERROR_CHROME_UNSUPPORTED_PLATFORM: 'ERROR_CHROME_UNSUPPORTED_PLATFORM',
  ERROR_CHROME_NOT_FOUND: 'ERROR_CHROME_NOT_FOUND'
}

export class FinderError extends Error {
  readonly code: string

  constructor(message = 'Unexpected error', code = 'ERROR_UNEXPECTED') {
    super(message)

    this.name = this.constructor.name
    this.code = code

    Error.captureStackTrace?.(this, this.constructor)
  }
}

export class UnsupportedPlatformError extends FinderError {
  constructor(platform: string = getPlatform()) {
    super(`Platform ${platform} is not supported.`, ErrorCodes.ERROR_CHROME_UNSUPPORTED_PLATFORM)
  }
}

export class ChromeNotInstalledError extends FinderError {
  constructor() {
    super('Could not find a Chrome installation.', ErrorCodes.ERROR_CHROME_NOT_FOUND)
  }
}

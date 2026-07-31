import finders from './platforms/index.js'
import getPlatform from './platforms/get-platform.js'
import { ChromeNotInstalledError, UnsupportedPlatformError } from './finder-errors.js'
import canAccess from '../file-access.js'

interface ChromeCache {
  key: string
  path: string
}

export class ChromeFinder {
  #cache: ChromeCache | null = null
  #platform: ReturnType<typeof getPlatform> | null = null

  #getCacheKey(platform: string): string {
    return [platform, process.env.CHROME_PATH || '', process.env.LIGHTHOUSE_CHROMIUM_PATH || ''].join('\0')
  }

  find(): string {
    const platform = (this.#platform ??= getPlatform())
    const cacheKey = this.#getCacheKey(platform)

    if (this.#cache?.key === cacheKey && canAccess(this.#cache.path)) {
      return this.#cache.path
    }

    const finder = finders[platform as keyof typeof finders]

    if (!finder) {
      throw new UnsupportedPlatformError(platform)
    }

    const chromePath = finder()[0]

    if (!chromePath) {
      throw new ChromeNotInstalledError()
    }

    this.#cache = { key: cacheKey, path: chromePath }

    return chromePath
  }
}

export default ChromeFinder

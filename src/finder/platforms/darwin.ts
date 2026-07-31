import childProcess from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import canAccess from '../../file-access.js'
import { escapeRegex, newLineRegex, sortByPriority } from './candidate-utils.js'

const PRIORITY = {
  SYSTEM_STABLE: 700,
  SYSTEM_CANARY: 690,

  USER_STABLE: 600,
  USER_CANARY: 590,

  VOLUME_STABLE: 100,
  VOLUME_CANARY: 90,

  DEFAULT: 0
}
const appSuffixes = ['/Contents/MacOS/Google Chrome Canary', '/Contents/MacOS/Google Chrome']
const lsRegister =
  '/System/Library/Frameworks/CoreServices.framework' +
  '/Versions/A/Frameworks/LaunchServices.framework' +
  '/Versions/A/Support/lsregister'

function getPriorities(): Array<{ regex: RegExp; weight: number }> {
  const home = escapeRegex(process.env.HOME || os.homedir())

  return [
    {
      regex: /^\/Applications\/.*Chrome Canary\.app/,
      weight: PRIORITY.SYSTEM_CANARY
    },
    {
      regex: /^\/Applications\/.*Chrome\.app/,
      weight: PRIORITY.SYSTEM_STABLE
    },

    {
      regex: new RegExp(`^${home}/Applications/.*Chrome Canary\\.app`),
      weight: PRIORITY.USER_CANARY
    },
    {
      regex: new RegExp(`^${home}/Applications/.*Chrome\\.app`),
      weight: PRIORITY.USER_STABLE
    },

    {
      regex: /^\/Volumes\/.*Chrome Canary\.app/,
      weight: PRIORITY.VOLUME_CANARY
    },
    {
      regex: /^\/Volumes\/.*Chrome\.app/,
      weight: PRIORITY.VOLUME_STABLE
    }
  ]
}

export function getAppPath(line: string): string | null {
  const match = /\/.*?\.app/.exec(line)

  if (!match) {
    return null
  }

  return match[0].trim()
}

function findRegisteredApps() {
  try {
    const output = childProcess.execFileSync(lsRegister, ['-dump'], { stdio: 'pipe' }).toString()
    const chromePaths: string[] = []

    for (const installation of output.split(newLineRegex)) {
      if (!/google chrome( canary)?\.app/i.test(installation)) {
        continue
      }

      const appPath = getAppPath(installation)

      if (!appPath) {
        continue
      }

      const paths = appSuffixes.map((suffix) => path.join(appPath, suffix))

      for (const chromePath of paths) {
        if (canAccess(chromePath)) {
          chromePaths.push(chromePath)
        }
      }
    }

    return chromePaths
  } catch {
    return []
  }
}

export default function darwin() {
  const directPath = [
    process.env.CHROME_PATH,
    process.env.LIGHTHOUSE_CHROMIUM_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
  ].find((chromePath) => chromePath && canAccess(chromePath))

  if (directPath) {
    return [directPath]
  }

  return sortByPriority([...new Set(findRegisteredApps())], getPriorities(), PRIORITY.DEFAULT)
}

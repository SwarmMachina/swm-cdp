import childProcess from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import canAccess from '../../file-access.js'
import { escapeRegex, newLineRegex, sortByPriority } from './candidate-utils.js'
import resolveChromePath from './resolve-chrome-path.js'

const executableNames = ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium']
const priorities = [
  { regex: /chrome-wrapper$/, weight: 51 },
  { regex: /google-chrome-stable$/, weight: 50 },
  { regex: /google-chrome$/, weight: 49 },
  { regex: /chromium-browser$/, weight: 48 },
  { regex: /chromium$/, weight: 47 }
]

function findDesktopExecutables(folder: string): string[] {
  if (!canAccess(folder)) {
    return []
  }

  const execRegex = '^Exec=/.*/(google-chrome|chrome|chromium)-.*'
  const argsList = [
    ['-ER', execRegex, folder],
    ['-Er', execRegex, folder]
  ]

  for (const args of argsList) {
    try {
      return childProcess
        .execFileSync('grep', args, { stdio: 'pipe' })
        .toString()
        .split(newLineRegex)
        .map((line) =>
          line
            .slice(line.indexOf('Exec=') + 5)
            .trim()
            .replace(/(^[^ ]+).*/, '$1')
        )
        .filter((execPath) => execPath.length > 0 && canAccess(execPath))
    } catch {
      //
    }
  }

  return []
}

function findInPath(executable: string): string | null {
  try {
    const chromePath = childProcess
      .execFileSync('which', [executable], { stdio: 'pipe' })
      .toString()
      .split(newLineRegex)[0]

    return chromePath && canAccess(chromePath) ? chromePath : null
  } catch {
    return null
  }
}

export interface LinuxFinderOptions {
  chromePath?: string | null
  desktopFolders?: string[]
  executableNames?: string[]
  findDesktopExecutables?: (folder: string) => string[]
  findInPath?: (executable: string) => string | null
}

export default function linux(options: LinuxFinderOptions = {}): string[] {
  const {
    desktopFolders = [path.join(os.homedir(), '.local/share/applications/'), '/usr/share/applications/'],
    executableNames: names = executableNames,
    findDesktopExecutables: desktopFinder = findDesktopExecutables,
    findInPath: pathFinder = findInPath
  } = options
  const chromePath = Object.hasOwn(options, 'chromePath') ? options.chromePath : resolveChromePath()
  const installations = [chromePath, ...desktopFolders.flatMap(desktopFinder), ...names.map(pathFinder)].filter(
    (entry): entry is string => Boolean(entry)
  )
  const weightedPriorities = process.env.CHROME_PATH
    ? [{ regex: new RegExp(escapeRegex(process.env.CHROME_PATH)), weight: 101 }, ...priorities]
    : priorities

  return sortByPriority([...new Set(installations)], weightedPriorities)
}

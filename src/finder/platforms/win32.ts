import path from 'node:path'
import canAccess from '../../file-access.js'
import resolveChromePath from './resolve-chrome-path.js'

const chromeRelativePaths = [
  ['Google', 'Chrome', 'Application', 'chrome.exe'],
  ['Google', 'Chrome SxS', 'Application', 'chrome.exe'],
  ['Google', 'Chrome Beta', 'Application', 'chrome.exe'],
  ['Google', 'Chrome Dev', 'Application', 'chrome.exe'],
  ['Chromium', 'Application', 'chrome.exe']
]
const envKeys = [
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'ProgramFiles',
  'ProgramW6432',
  'PROGRAMFILES(X86)',
  'ProgramFiles(x86)',
  'ProgramData'
]

export default function win32(env = process.env) {
  const candidates = []
  const chromePath = resolveChromePath()

  if (chromePath) {
    candidates.push(chromePath)
  }

  for (const key of envKeys) {
    const prefix = env[key]

    if (!prefix) {
      continue
    }

    for (const chromeRelativePath of chromeRelativePaths) {
      const chromePath = path.join(prefix, ...chromeRelativePath)

      if (canAccess(chromePath)) {
        candidates.push(chromePath)
      }
    }
  }

  return candidates
}

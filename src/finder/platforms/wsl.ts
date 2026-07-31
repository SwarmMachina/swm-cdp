import fs from 'node:fs'
import os from 'node:os'
import isDocker from './is-docker.js'
import { execFileSync } from 'node:child_process'
import win32 from './win32.js'

function hasMicrosoftKernelMarker() {
  if (os.release().toLowerCase().includes('microsoft')) {
    return true
  }

  try {
    return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')
  } catch {
    return false
  }
}

export function isWsl() {
  return process.platform === 'linux' && hasMicrosoftKernelMarker() && !isDocker()
}

function getLocalAppDataPath(path = '') {
  const [, drive, user] = /\/mnt\/([a-z])\/Users\/([^/:]+)\/AppData\//.exec(path) || []

  return drive && user ? `/mnt/${drive}/Users/${user}/AppData/Local` : ''
}

export function toWSLPath(dir: string, fallback: string): string {
  try {
    return execFileSync('wslpath', ['-u', dir]).toString().trim()
  } catch {
    return fallback
  }
}

export function getWSLLocalAppDataPath(path = '') {
  const [, drive, user] = /\/([a-z])\/Users\/([^/:]+)\/AppData\//.exec(path) || []
  const fallback = getLocalAppDataPath(path)

  return drive && user ? toWSLPath(`${drive}:\\Users\\${user}\\AppData\\Local`, fallback) : fallback
}

export default function wsl() {
  const env = {
    ...process.env,
    LOCALAPPDATA: getWSLLocalAppDataPath(process.env.PATH),
    PROGRAMFILES: toWSLPath('C:/Program Files', '/mnt/c/Program Files'),
    'PROGRAMFILES(X86)': toWSLPath('C:/Program Files (x86)', '/mnt/c/Program Files (x86)')
  }

  return win32(env)
}

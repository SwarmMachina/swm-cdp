import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import ChromeFinder from '../../src/finder/find-chrome.js'
import darwin, { getAppPath } from '../../src/finder/platforms/darwin.js'
import { ChromeNotInstalledError, ErrorCodes } from '../../src/finder/finder-errors.js'
import linux from '../../src/finder/platforms/linux.js'
import win32 from '../../src/finder/platforms/win32.js'
import { getWSLLocalAppDataPath } from '../../src/finder/platforms/wsl.js'
import { sortByPriority } from '../../src/finder/platforms/candidate-utils.js'

function setEnv(key: string, value: string | undefined): () => void {
  const previous = process.env[key]

  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }

  return () => {
    if (previous === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = previous
    }
  }
}

function makeExecutable(dir: string, name: string): string {
  const file = path.join(dir, name)

  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(file, 0o755)

  return file
}

test('darwin getAppPath extracts app path from lsregister output', () => {
  assert.equal(
    getAppPath('    path: /Users/alice/Applications/Google Chrome.app'),
    '/Users/alice/Applications/Google Chrome.app'
  )
  assert.equal(
    getAppPath('    path: /Volumes/Tools/Google Chrome Canary.app'),
    '/Volumes/Tools/Google Chrome Canary.app'
  )
  assert.equal(getAppPath('    bindings: com.google.Chrome'), null)
})

test('darwin prefers an explicit executable path', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swm-cdp-darwin-'))
  const executable = makeExecutable(dir, 'Google Chrome')
  const restoreChromePath = setEnv('CHROME_PATH', executable)

  t.after(() => {
    restoreChromePath()
    fs.rmSync(dir, { force: true, recursive: true })
  })

  assert.deepEqual(darwin(), [executable])
})

test('linux returns an empty candidate list when discovery finds nothing', () => {
  const candidates = linux({
    chromePath: null,
    desktopFolders: [],
    executableNames: [],
    findDesktopExecutables: () => [],
    findInPath: () => null
  })

  assert.deepEqual(candidates, [])
})

test('linux returns each discovered executable once', () => {
  const executable = '/opt/google/chrome'
  const candidates = linux({
    chromePath: executable,
    desktopFolders: ['/applications'],
    executableNames: ['chrome'],
    findDesktopExecutables: () => [executable],
    findInPath: () => executable
  })

  assert.deepEqual(candidates, [executable])
})

test('win32 discovers Chrome below a native LOCALAPPDATA path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swm-cdp-win32-'))
  const executable = path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')

  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(executable, '')
  fs.chmodSync(executable, 0o755)
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))

  assert.ok(win32({ LOCALAPPDATA: root }).includes(executable))
})

test('WSL derives Windows Local AppData from mounted PATH entries', () => {
  assert.equal(
    getWSLLocalAppDataPath('/mnt/c/Users/Alice/AppData/Local/Programs/bin'),
    '/mnt/c/Users/Alice/AppData/Local'
  )
  assert.equal(getWSLLocalAppDataPath('/usr/local/bin'), '')
})

test('finder errors expose stable names, messages, and codes', () => {
  const error = new ChromeNotInstalledError()

  assert.equal(error.name, 'ChromeNotInstalledError')
  assert.equal(error.message, 'Could not find a Chrome installation.')
  assert.equal(error.code, ErrorCodes.ERROR_CHROME_NOT_FOUND)
  assert.ok(error instanceof Error)
})

test('sortByPriority is stable for candidates with equal weights', () => {
  const candidates = ['/opt/chrome-canary', '/opt/chrome-stable', '/custom/chrome']
  const priorities = [
    { regex: /chrome-stable$/, weight: 100 },
    { regex: /chrome-canary$/, weight: 90 }
  ]

  assert.deepEqual(sortByPriority(candidates, priorities, 0), [
    '/opt/chrome-stable',
    '/opt/chrome-canary',
    '/custom/chrome'
  ])
  assert.deepEqual(sortByPriority(['/first', '/second'], [], 0), ['/first', '/second'])
})

test('ChromeFinder invalidates its cache when CHROME_PATH changes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swm-cdp-finder-'))
  const firstChrome = makeExecutable(dir, 'chrome-one')
  const secondChrome = makeExecutable(dir, 'chrome-two')
  const restoreChromePath = setEnv('CHROME_PATH', firstChrome)
  const restoreLighthousePath = setEnv('LIGHTHOUSE_CHROMIUM_PATH', undefined)

  t.after(() => {
    restoreChromePath()
    restoreLighthousePath()
    fs.rmSync(dir, { force: true, recursive: true })
  })

  const finder = new ChromeFinder()

  assert.equal(finder.find(), firstChrome)

  process.env.CHROME_PATH = secondChrome

  assert.equal(finder.find(), secondChrome)
})

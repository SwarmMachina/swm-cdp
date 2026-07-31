import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'

import connect from '../../src/cdp/connect.js'
import WebSocketTransport from '../../src/cdp/transport/ws-transport.js'
import ChromeFinder from '../../src/finder/find-chrome.js'
import type Browser from '../../src/spawn/browser.js'
import spawnChrome from '../../src/spawn/spawn-chrome.js'
import runCdpScenario from './cdp-scenario.js'

test('spawnChrome covers evaluate, navigate, screenshot, flat sessions, and tracing', async (t) => {
  const chromeExecutable = resolveE2EChrome(t)

  if (!chromeExecutable) {
    return
  }

  for (const transport of ['pipe', 'ws'] as const) {
    await t.test(transport, async () => {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swm-cdp-'))

      let chrome: Browser | null = null
      let remote: Awaited<ReturnType<typeof connect>> | null = null

      try {
        chrome = spawnChrome({
          chromeExecutable,
          transport,
          port: 0,
          disableDefaultArguments: false,
          headless: true,
          userDataDir,
          url: 'about:blank'
        })

        const cdp = await chrome.attach()
        const product = await runCdpScenario(cdp)

        assert.equal(typeof product, 'string')

        if (transport === 'ws') {
          if (!(chrome.transport instanceof WebSocketTransport)) {
            throw new Error('Expected a WebSocket transport')
          }

          remote = await connect(chrome.transport.url)
          const remoteVersion = await remote.send('Browser.getVersion')

          assert.equal(remoteVersion.product, product)
          await remote.close()
          assert.equal(typeof (await cdp.send('Browser.getVersion')).product, 'string')
        }

        const closing = chrome.close()

        assert.equal(chrome.close(), closing)
        await closing
        assert.equal(chrome.closed, true)
        assert.equal(chrome.isExited, true)
        assert.equal(cdp.closed, true)
      } finally {
        if (remote && !remote.closed) {
          await remote.close()
        }

        if (chrome && !chrome.closed) {
          await chrome.dispose()
        }

        fs.rmSync(userDataDir, { force: true, recursive: true })
      }
    })
  }
})

test('spawnChrome rejects in-flight commands after the owned process exits', async (t) => {
  const chromeExecutable = resolveE2EChrome(t)

  if (!chromeExecutable) {
    return
  }

  for (const transport of ['pipe', 'ws'] as const) {
    await t.test(transport, async () => {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swm-cdp-crash-'))

      let chrome: Browser | null = null

      try {
        chrome = spawnChrome({
          chromeExecutable,
          transport,
          port: 0,
          disableDefaultArguments: false,
          headless: true,
          userDataDir,
          url: 'about:blank'
        })

        const cdp = await chrome.attach()
        const target = await cdp.send('Target.createTarget', { url: 'about:blank' })
        const { sessionId } = await cdp.send('Target.attachToTarget', {
          flatten: true,
          targetId: target.targetId
        })
        const pending = cdp.send(
          'Runtime.evaluate',
          { awaitPromise: true, expression: 'Promise.withResolvers().promise' },
          sessionId,
          { timeout: 30_000 }
        )
        const rejected = assert.rejects(pending, /already closed/)

        await chrome.kill(5_000)
        await rejected
        assert.equal(chrome.closed, true)
        assert.equal(chrome.isExited, true)
        assert.equal(cdp.closed, true)
      } finally {
        if (chrome && !chrome.closed) {
          await chrome.dispose()
        }

        fs.rmSync(userDataDir, { force: true, recursive: true })
      }
    })
  }
})

function resolveE2EChrome(context: TestContext): string | null {
  let executable: string

  try {
    executable = new ChromeFinder().find()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    skipOrFail(context, `Chrome executable not found: ${message}`, error)

    return null
  }

  if (isMacOsSystemChrome(executable)) {
    skipOrFail(
      context,
      'macOS system Chrome can abort before CDP starts in headless mode; set CHROME_PATH to Chrome Headless Shell or Chrome for Testing'
    )

    return null
  }

  return executable
}

function skipOrFail(context: TestContext, message: string, cause?: unknown): void {
  if (process.env.SWM_CDP_E2E_REQUIRED === '1') {
    throw new Error(message, cause === undefined ? undefined : { cause })
  }

  context.skip(message)
}

function isMacOsSystemChrome(executable: string): boolean {
  if (process.platform !== 'darwin') {
    return false
  }

  const resolvedExecutable = fs.realpathSync.native(executable)

  return /\/Google Chrome(?: Canary)?\.app\/Contents\/MacOS\/Google Chrome(?: Canary)?$/.test(resolvedExecutable)
}

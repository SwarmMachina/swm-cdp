import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import connect from '../../src/cdp/connect.js'
import { closeTarget, createTarget, list, version } from '../../src/discovery.js'

test('container endpoint covers discovery limits, request pressure, and reconnect', async (t) => {
  const discoveryUrl = process.env.SWM_CDP_CONTAINER_CHROME

  if (!discoveryUrl) {
    t.skip('SWM_CDP_CONTAINER_CHROME is not set')

    return
  }

  const browser = await version(discoveryUrl)

  assert.equal(typeof browser.webSocketDebuggerUrl, 'string')
  await assert.rejects(version(discoveryUrl, { maxResponseBytes: 1 }), /response byte limit exceeded/)
  assert.equal((await version(discoveryUrl)).Browser, browser.Browser)

  const target = await createTarget(discoveryUrl, 'data:text/html,<title>discovery</title>')

  try {
    assert.equal(target.type, 'page')
    await waitForTarget(discoveryUrl, target.id, true)

    const first = await connect(browser.webSocketDebuggerUrl!, { maxPendingRequests: 1 })

    try {
      const { sessionId } = await first.send('Target.attachToTarget', { flatten: true, targetId: target.id })
      const pending = first.send(
        'Runtime.evaluate',
        { awaitPromise: true, expression: 'Promise.withResolvers().promise' },
        sessionId,
        { timeout: 25 }
      )
      const timedOut = assert.rejects(pending, /Request timeout exceeded/)

      await assert.rejects(first.send('Browser.getVersion'), /Pending request limit exceeded/)
      await timedOut
      assert.equal((await first.send('Browser.getVersion')).product, browser.Browser)

      const closing = first.close()

      assert.equal(first.close(), closing)
      await closing
      assert.equal(first.closed, true)
    } finally {
      if (!first.closed) {
        await first.close()
      }
    }

    const second = await connect(browser.webSocketDebuggerUrl!)

    try {
      assert.equal((await second.send('Browser.getVersion')).product, browser.Browser)
    } finally {
      await second.close()
    }
  } finally {
    await closeTarget(target.id, discoveryUrl)
  }

  await waitForTarget(discoveryUrl, target.id, false)
})

async function waitForTarget(discoveryUrl: string, targetId: string, expected: boolean): Promise<void> {
  const deadline = Date.now() + 5_000

  do {
    const exists = (await list(discoveryUrl, { timeout: 1_000 })).some((target) => target.id === targetId)

    if (exists === expected) {
      return
    }

    await delay(25)
  } while (Date.now() < deadline)

  throw new Error(`Target ${targetId} did not become ${expected ? 'visible' : 'absent'} before the deadline`)
}

import assert from 'node:assert/strict'
import test from 'node:test'

import connect from '../../src/cdp/connect.js'
import { version } from '../../src/discovery.js'
import runCdpScenario from './cdp-scenario.js'

test('connects to headless Chrome running in Docker', async (t) => {
  const discoveryUrl = process.env.SWM_CDP_CONTAINER_CHROME

  if (!discoveryUrl) {
    t.skip('SWM_CDP_CONTAINER_CHROME is not set')

    return
  }

  const browser = await version(discoveryUrl)

  assert.equal(typeof browser.webSocketDebuggerUrl, 'string')

  const cdp = await connect(browser.webSocketDebuggerUrl!)

  try {
    assert.equal(await runCdpScenario(cdp), browser.Browser)
  } finally {
    await cdp.close()
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'

import CDP from 'chrome-remote-interface'

import connect from '../../src/cdp/connect.js'
import { version } from '../../src/discovery.js'

test('public command results match chrome-remote-interface', async (t) => {
  const discoveryUrl = process.env.SWM_CDP_CONTAINER_CHROME

  if (!discoveryUrl) {
    t.skip('SWM_CDP_CONTAINER_CHROME is not set')

    return
  }

  const browser = await version(discoveryUrl)

  assert.equal(typeof browser.webSocketDebuggerUrl, 'string')
  const endpoint = browser.webSocketDebuggerUrl!
  const swm = await connect(endpoint)
  const cri = await CDP({ target: endpoint })

  try {
    const swmSend = swm.send as RawSend
    const criSend = cri.send.bind(cri) as RawSend
    const [swmSnapshot, criSnapshot] = await Promise.all([captureSnapshot(swmSend), captureSnapshot(criSend)])

    assert.deepEqual(swmSnapshot, criSnapshot)
  } finally {
    await Promise.allSettled([swm.close(), cri.close()])
  }
})

interface BrowserVersion {
  product: string
  protocolVersion: string
}

interface CreatedTarget {
  targetId: string
}

interface AttachedTarget {
  sessionId: string
}

interface Evaluation {
  result: { value: unknown }
}

type RawSend = <Result>(method: string, params?: object, sessionId?: string) => Promise<Result>

async function captureSnapshot(send: RawSend): Promise<object> {
  const versionInfo = await send<BrowserVersion>('Browser.getVersion')
  const target = await send<CreatedTarget>('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send<AttachedTarget>('Target.attachToTarget', {
    flatten: true,
    targetId: target.targetId
  })

  try {
    await send('Runtime.enable', undefined, sessionId)

    const evaluated = await send<Evaluation>(
      'Runtime.evaluate',
      {
        expression: '({answer: 6 * 7, language: navigator.language})',
        returnByValue: true
      },
      sessionId
    )

    return {
      product: versionInfo.product,
      protocolVersion: versionInfo.protocolVersion,
      runtime: evaluated.result.value
    }
  } finally {
    await send('Target.closeTarget', { targetId: target.targetId })
  }
}

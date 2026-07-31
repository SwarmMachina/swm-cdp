import assert from 'node:assert/strict'

import type { CdpClient } from '../../src/index.js'

/** Runs the public CDP surface used by both owned-Chrome and container e2e tests. */
export default async function runCdpScenario(cdp: CdpClient): Promise<string> {
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { flatten: true, targetId: target.targetId })
  const [version] = await Promise.all([
    cdp.send('Browser.getVersion'),
    cdp.send('Page.enable', undefined, sessionId),
    cdp.send('Runtime.enable', undefined, sessionId)
  ])
  const loaded = waitForSessionEvent(cdp, 'Page.loadEventFired', sessionId)
  const navigation = await cdp.send(
    'Page.navigate',
    { url: 'data:text/html,<title>swm-cdp</title><main>ready</main>' },
    sessionId
  )

  assert.equal(navigation.errorText, undefined)
  await loaded

  const evaluation = await cdp.send(
    'Runtime.evaluate',
    { expression: 'document.title', returnByValue: true },
    sessionId
  )

  assert.equal(evaluation.result.value, 'swm-cdp')

  await verifyConcurrentSessions(cdp, sessionId)

  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  const screenshotBytes = Buffer.from(screenshot.data, 'base64')

  assert.equal(screenshotBytes.subarray(1, 4).toString('ascii'), 'PNG')
  assert.ok(screenshotBytes.byteLength > 1_000)

  const tracingComplete = cdp.once('Tracing.tracingComplete')

  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline',
    transferMode: 'ReturnAsStream'
  })
  await cdp.send('Runtime.evaluate', { expression: 'Array.from({length: 1000}, (_, i) => i).join()' }, sessionId)
  await cdp.send('Tracing.end')

  const tracing = await tracingComplete

  assert.equal(typeof tracing.stream, 'string')
  assert.ok((await readStream(cdp, tracing.stream!)).byteLength > 0)

  const stalledEvaluation = cdp.send(
    'Runtime.evaluate',
    { awaitPromise: true, expression: 'Promise.withResolvers().promise' },
    sessionId,
    { timeout: 25 }
  )

  await assert.rejects(stalledEvaluation, /Request timeout exceeded/)
  assert.equal(typeof (await cdp.send('Browser.getVersion')).product, 'string')
  assert.equal((await cdp.send('Target.closeTarget', { targetId: target.targetId })).success, true)

  return version.product
}

async function verifyConcurrentSessions(cdp: CdpClient, primarySessionId: string): Promise<void> {
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { flatten: true, targetId: target.targetId })

  try {
    await cdp.send('Runtime.enable', undefined, sessionId)

    const expected = Array.from({ length: 32 }, (_, index) => index * 17)
    const evaluations = expected.map((value, index) =>
      cdp.send(
        'Runtime.evaluate',
        {
          awaitPromise: true,
          expression: `(() => {
            const { promise, resolve } = Promise.withResolvers()
            setTimeout(() => resolve(${value}), ${(31 - index) % 8})
            return promise
          })()`,
          returnByValue: true
        },
        index % 2 === 0 ? primarySessionId : sessionId
      )
    )

    assert.deepEqual(
      (await Promise.all(evaluations)).map(({ result }) => result.value),
      expected
    )
  } finally {
    assert.equal((await cdp.send('Target.closeTarget', { targetId: target.targetId })).success, true)
  }
}

async function waitForSessionEvent(cdp: CdpClient, eventName: string, expectedSessionId: string): Promise<unknown> {
  const { resolve, promise } = Promise.withResolvers<unknown>()
  const unsubscribe = cdp.on(eventName, (event, sessionId) => {
    if (sessionId === expectedSessionId) {
      unsubscribe()
      resolve(event)
    }
  })

  return promise
}

async function readStream(cdp: CdpClient, handle: string): Promise<Buffer> {
  const chunks: Buffer[] = []

  try {
    for (;;) {
      const chunk = await cdp.send('IO.read', { handle, size: 64 * 1024 })

      chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'))

      if (chunk.eof) {
        return Buffer.concat(chunks)
      }
    }
  } finally {
    await cdp.send('IO.close', { handle })
  }
}

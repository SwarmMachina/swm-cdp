import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'

import { CdpError, spawnChrome, type CdpClient } from '../../src/index.js'
import type Browser from '../../src/spawn/browser.js'

test('Chrome for Testing exercises the public browser, session, page, network, and lifecycle surface', async (t) => {
  const chromeExecutable = resolveChromeForTesting(t)

  if (!chromeExecutable) {
    return
  }

  const fixture = await startFixtureServer()

  try {
    for (const transport of ['pipe', 'ws'] as const) {
      await t.test(transport, async () => {
        await runPublicSurfaceScenario(chromeExecutable, transport, fixture.url)
      })
    }
  } finally {
    await closeServer(fixture.server)
  }
})

async function runPublicSurfaceScenario(
  chromeExecutable: string,
  transport: 'pipe' | 'ws',
  fixtureUrl: string
): Promise<void> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swm-cdp-cft-'))

  let browser: Browser | null = null
  let cdp: CdpClient | null = null
  let targetId: string | null = null

  try {
    browser = spawnChrome({
      chromeExecutable,
      disableDefaultArguments: false,
      headless: true,
      transport,
      userDataDir,
      url: 'about:blank'
    })
    cdp = await browser.attach()

    assert.equal(browser.attached, true)
    assert.equal(browser.connection, cdp)
    assert.equal(typeof browser.pid, 'number')
    assert.match((await cdp.send('Browser.getVersion')).product, /Chrome\//)

    await cdp.send('Target.setDiscoverTargets', { discover: true })
    await cdp.send('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: false })

    const initialTargetUrl = 'data:text/html,swm-cdp-auto-attach'
    const autoAttached = waitForEvent(cdp, 'Target.attachedToTarget', (event) => hasTargetUrl(event, initialTargetUrl))
    const target = await cdp.send('Target.createTarget', { url: initialTargetUrl })
    const currentTargetId = target.targetId
    const sessionId = getAttachedSessionId(await autoAttached)

    targetId = currentTargetId

    await Promise.all([
      cdp.send('DOM.enable', undefined, sessionId),
      cdp.send('Network.enable', undefined, sessionId),
      cdp.send('Page.enable', undefined, sessionId),
      cdp.send('Performance.enable', undefined, sessionId),
      cdp.send('Runtime.enable', undefined, sessionId)
    ])

    const preload = await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: "globalThis.__swmCdpPreload = 'ready'" },
      sessionId
    )
    const bootLogged = waitForSessionEvent(cdp, 'Runtime.consoleAPICalled', sessionId, (event) =>
      hasConsoleText(event, 'fixture booted')
    )
    const loaded = waitForSessionEvent(cdp, 'Page.loadEventFired', sessionId)
    const targetChanged = waitForEvent(cdp, 'Target.targetInfoChanged', (event) =>
      hasTargetUrl(event, fixtureUrl, currentTargetId)
    )
    const navigation = await cdp.send('Page.navigate', { url: fixtureUrl }, sessionId)

    assert.equal(navigation.errorText, undefined)
    await Promise.all([bootLogged, loaded, targetChanged])

    assert.equal(
      (await cdp.send('Runtime.evaluate', { expression: 'globalThis.__swmCdpPreload', returnByValue: true }, sessionId))
        .result.value,
      'ready'
    )
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: preload.identifier }, sessionId)

    const document = await cdp.send('DOM.getDocument', { depth: 2 }, sessionId)
    const button = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#action' }, sessionId)

    assert.ok(button.nodeId > 0)
    assert.match((await cdp.send('DOM.getOuterHTML', { nodeId: button.nodeId }, sessionId)).outerHTML, /Load answer/)

    const responseReceived = waitForSessionEvent(cdp, 'Network.responseReceived', sessionId, (event) =>
      hasResponseUrl(event, '/api/answer')
    )
    const answerLogged = waitForSessionEvent(cdp, 'Runtime.consoleAPICalled', sessionId, (event) =>
      hasConsoleText(event, 'answer:42')
    )
    const bindingCalled = waitForSessionEvent(cdp, 'Runtime.bindingCalled', sessionId, (event) =>
      hasBindingPayload(event, 'bound:42')
    )

    await cdp.send('Runtime.addBinding', { name: 'swmCdpBinding' }, sessionId)
    assert.equal(
      (await cdp.send('Network.setCookie', { name: 'swm-cdp', url: fixtureUrl, value: 'session' }, sessionId)).success,
      true
    )

    await cdp.send(
      'Runtime.evaluate',
      {
        expression: "document.querySelector('#action').click(); globalThis.swmCdpBinding('bound:42')",
        returnByValue: true
      },
      sessionId
    )
    const [response] = await Promise.all([responseReceived, answerLogged, bindingCalled])
    const responseBody = await cdp.send(
      'Network.getResponseBody',
      { requestId: getNetworkRequestId(response) },
      sessionId
    )

    assert.equal(responseBody.body, '{"answer":"42"}')
    assert.equal(responseBody.base64Encoded, false)
    assert.equal(
      (await cdp.send('Network.getCookies', { urls: [fixtureUrl] }, sessionId)).cookies.some(
        ({ name, value }) => name === 'swm-cdp' && value === 'session'
      ),
      true
    )

    const pageState = await cdp.send(
      'Runtime.evaluate',
      {
        expression:
          "({ title: document.title, answer: document.querySelector('#answer').textContent, href: location.href })",
        returnByValue: true
      },
      sessionId
    )

    assert.deepEqual(pageState.result.value, {
      answer: '42',
      href: fixtureUrl,
      title: 'swm-cdp Chrome for Testing fixture'
    })

    const frameTree = await cdp.send('Page.getFrameTree', undefined, sessionId)
    const isolatedWorld = await cdp.send(
      'Page.createIsolatedWorld',
      { frameId: frameTree.frameTree.frame.id, worldName: 'swm-cdp-e2e' },
      sessionId
    )
    const isolatedEvaluation = await cdp.send(
      'Runtime.evaluate',
      { contextId: isolatedWorld.executionContextId, expression: '6 * 7', returnByValue: true },
      sessionId
    )

    assert.equal(isolatedEvaluation.result.value, 42)
    assert.ok((await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [] }, sessionId)).documents.length > 0)
    assert.ok((await cdp.send('Accessibility.getFullAXTree', undefined, sessionId)).nodes.length > 0)
    assert.equal((await cdp.send('Page.getLayoutMetrics', undefined, sessionId)).contentSize.width > 0, true)

    await cdp.send('Emulation.setEmulatedMedia', { media: 'print' }, sessionId)
    assert.equal(
      (
        await cdp.send(
          'Runtime.evaluate',
          { expression: "matchMedia('print').matches", returnByValue: true },
          sessionId
        )
      ).result.value,
      true
    )
    await cdp.send('Emulation.setEmulatedMedia', {}, sessionId)

    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
    const screenshotBytes = Buffer.from(screenshot.data, 'base64')

    assert.equal(screenshotBytes.subarray(1, 4).toString('ascii'), 'PNG')
    assert.ok(screenshotBytes.byteLength > 1_000)
    assert.ok(
      (await cdp.send('Performance.getMetrics', undefined, sessionId)).metrics.some(({ name }) => name === 'Timestamp')
    )

    const pdf = await cdp.send('Page.printToPDF', { printBackground: true, transferMode: 'ReturnAsStream' }, sessionId)
    const pdfBytes = await readProtocolStream(cdp, pdf.stream!, sessionId)

    assert.equal(pdfBytes.subarray(0, 4).toString('ascii'), '%PDF')

    await assert.rejects(cdp.send('SwmCdp.doesNotExist'), (error: unknown) => error instanceof CdpError)

    const controller = new AbortController()
    const aborted = cdp.send(
      'Runtime.evaluate',
      { awaitPromise: true, expression: 'Promise.withResolvers().promise' },
      sessionId,
      { signal: controller.signal, timeout: 5_000 }
    )

    controller.abort()
    await assert.rejects(aborted, { name: 'AbortError' })
    assert.equal(typeof (await cdp.send('Browser.getVersion')).product, 'string')

    assert.equal((await cdp.send('Target.closeTarget', { targetId: currentTargetId })).success, true)
    await cdp.send('Target.setAutoAttach', { autoAttach: false, flatten: true, waitForDebuggerOnStart: false })
    targetId = null

    const closing = browser.close()

    assert.equal(browser.close(), closing)
    await closing
    assert.equal(browser.closed, true)
    assert.equal(browser.isExited, true)
    assert.equal(cdp.closed, true)
  } finally {
    if (cdp && targetId) {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined)
    }

    if (browser && !browser.closed) {
      await browser.close()
    }

    fs.rmSync(userDataDir, { force: true, recursive: true })
  }
}

function resolveChromeForTesting(context: TestContext): string | null {
  const executable = process.env.CHROME_PATH

  if (!executable) {
    context.skip('CHROME_PATH must point to the pinned Chrome for Testing executable')

    return null
  }

  if (!fs.existsSync(executable)) {
    throw new Error(`CHROME_PATH does not exist: ${executable}`)
  }

  return executable
}

function waitForEvent(cdp: CdpClient, eventName: string, predicate: (event: unknown) => boolean): Promise<unknown> {
  return waitForSessionEvent(cdp, eventName, undefined, predicate)
}

function waitForSessionEvent(
  cdp: CdpClient,
  eventName: string,
  expectedSessionId?: string,
  predicate: (event: unknown) => boolean = () => true
): Promise<unknown> {
  const { reject, resolve, promise } = Promise.withResolvers<unknown>()
  const timeout = setTimeout(() => {
    unsubscribe()
    reject(new Error(`Timed out waiting for ${eventName}`))
  }, 10_000)
  const unsubscribe = cdp.on(eventName, (event, sessionId) => {
    if (sessionId === expectedSessionId && predicate(event)) {
      clearTimeout(timeout)
      unsubscribe()
      resolve(event)
    }
  })

  return promise
}

function hasConsoleText(event: unknown, expected: string): boolean {
  if (!event || typeof event !== 'object' || !('args' in event) || !Array.isArray(event.args)) {
    return false
  }

  return event.args.some(
    (argument) => argument && typeof argument === 'object' && 'value' in argument && argument.value === expected
  )
}

function hasBindingPayload(event: unknown, expected: string): boolean {
  return (
    !!event &&
    typeof event === 'object' &&
    'payload' in event &&
    typeof event.payload === 'string' &&
    event.payload === expected
  )
}

function hasResponseUrl(event: unknown, pathname: string): boolean {
  return (
    !!event &&
    typeof event === 'object' &&
    'response' in event &&
    !!event.response &&
    typeof event.response === 'object' &&
    'url' in event.response &&
    typeof event.response.url === 'string' &&
    event.response.url.endsWith(pathname)
  )
}

function hasTargetUrl(event: unknown, url: string, targetId?: string): boolean {
  return (
    !!event &&
    typeof event === 'object' &&
    'targetInfo' in event &&
    !!event.targetInfo &&
    typeof event.targetInfo === 'object' &&
    'url' in event.targetInfo &&
    event.targetInfo.url === url &&
    (targetId === undefined || ('targetId' in event.targetInfo && event.targetInfo.targetId === targetId))
  )
}

function getAttachedSessionId(event: unknown): string {
  if (!event || typeof event !== 'object' || !('sessionId' in event) || typeof event.sessionId !== 'string') {
    throw new Error('Target.attachedToTarget did not include a session id')
  }

  return event.sessionId
}

function getNetworkRequestId(event: unknown): string {
  if (!event || typeof event !== 'object' || !('requestId' in event) || typeof event.requestId !== 'string') {
    throw new Error('Network.responseReceived did not include a request id')
  }

  return event.requestId
}

async function readProtocolStream(cdp: CdpClient, handle: string, sessionId?: string): Promise<Buffer> {
  const chunks: Buffer[] = []

  try {
    for (;;) {
      const chunk = await cdp.send('IO.read', { handle, size: 64 * 1024 }, sessionId)

      chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'))

      if (chunk.eof) {
        return Buffer.concat(chunks)
      }
    }
  } finally {
    await cdp.send('IO.close', { handle }, sessionId).catch(() => undefined)
  }
}

async function startFixtureServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    switch (request.url) {
      case '/':
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(`<!doctype html>
<title>swm-cdp Chrome for Testing fixture</title>
<main><button id="action">Load answer</button><output id="answer"></output></main>
<script>
  console.log('fixture booted')
  document.querySelector('#action').addEventListener('click', async () => {
    const { answer } = await fetch('/api/answer').then((result) => result.json())
    document.querySelector('#answer').textContent = answer
    console.log('answer:' + answer)
  })
</script>`)

        return
      case '/api/answer':
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end('{"answer":"42"}')

        return
      default:
        response.writeHead(404)
        response.end()
    }
  })
  const { reject, resolve, promise } = Promise.withResolvers<void>()

  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject)
    resolve()
  })
  await promise

  const address = server.address()

  if (!address || typeof address === 'string') {
    throw new Error('Fixture server did not bind to a TCP address')
  }

  return { server, url: `http://127.0.0.1:${address.port}/` }
}

async function closeServer(server: Server): Promise<void> {
  const { reject, resolve, promise } = Promise.withResolvers<void>()

  server.close((error) => (error ? reject(error) : resolve()))
  await promise
}

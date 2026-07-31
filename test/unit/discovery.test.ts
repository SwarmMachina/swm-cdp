import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import { closeTarget, createTarget, list, version } from '../../src/discovery.js'

test('discovery functions use bounded flat /json endpoints', async (t) => {
  const requests: { method?: string; url?: string }[] = []
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url })
    response.setHeader('content-type', 'application/json')

    if (request.url === '/json/version') {
      response.end(JSON.stringify({ Browser: 'Chrome/Test', 'Protocol-Version': '1.3' }))
    } else if (request.url === '/json/list') {
      response.end(JSON.stringify([{ id: 'page-1', type: 'page', url: 'about:blank' }]))
    } else if (request.url?.startsWith('/json/new?')) {
      response.end(JSON.stringify({ id: 'page-2', type: 'page', url: 'https://example.com/' }))
    } else {
      response.end('Target is closing')
    }
  })
  const { resolve, promise } = Promise.withResolvers<void>()

  server.listen(0, '127.0.0.1', resolve)
  await promise
  t.after(() => server.close())

  const address = server.address() as AddressInfo
  const target = { host: '127.0.0.1', port: address.port }

  assert.equal((await version(target)).Browser, 'Chrome/Test')
  await assert.rejects(version(target, { maxResponseBytes: 1 }), /response byte limit exceeded/)
  assert.equal((await list(target))[0]!.id, 'page-1')
  assert.equal((await createTarget(target, 'https://example.com/')).id, 'page-2')
  await closeTarget('page-2', target)

  assert.deepEqual(requests, [
    { method: 'GET', url: '/json/version' },
    { method: 'GET', url: '/json/version' },
    { method: 'GET', url: '/json/list' },
    { method: 'PUT', url: '/json/new?https%3A%2F%2Fexample.com%2F' },
    { method: 'GET', url: '/json/close/page-2' }
  ])
})

test('discovery validates target ids and protocols before I/O', async () => {
  await assert.rejects(closeTarget('', { host: '127.0.0.1' }), /targetId must/)
  // @ts-expect-error Runtime validation rejects non-string target ids.
  await assert.rejects(closeTarget(42, { host: '127.0.0.1' }), /targetId must/)
  await assert.rejects(list('file:///tmp/chrome'), /endpoint protocol must/)
})

test('discovery rejects HTTP errors and enforces the request deadline', async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/json/list') {
      response.statusCode = 503
      response.end()

      return
    }

    setTimeout(() => {
      response.end(JSON.stringify({ Browser: 'Chrome/Test', 'Protocol-Version': '1.3' }))
    }, 100)
  })
  const { resolve, promise } = Promise.withResolvers<void>()

  server.listen(0, '127.0.0.1', resolve)
  await promise
  t.after(() => server.close())

  const address = server.address() as AddressInfo
  const target = { host: '127.0.0.1', port: address.port }

  await assert.rejects(list(target), /HTTP 503/)
  await assert.rejects(version(target, { timeout: 10 }), /timeout exceeded/)
})

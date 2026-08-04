import assert from 'node:assert/strict'
import test from 'node:test'

import scanCdpEnvelope from '../../src/cdp/selective-json.js'

test('selective scanner extracts routing fields across nested payloads', () => {
  const message = JSON.stringify({
    method: 'Network.dataReceived',
    params: { data: ['}', { nested: 'sessionId' }], requestId: '42' },
    sessionId: 'session-1'
  })

  assert.deepEqual(scanCdpEnvelope(message), {
    method: 'Network.dataReceived',
    sessionId: 'session-1'
  })
  assert.deepEqual(scanCdpEnvelope('{"result":{"method":"not-an-event"},"id":7}'), {})
})

test('selective scanner rejects incomplete and structurally invalid envelopes', () => {
  assert.equal(scanCdpEnvelope('{"method":"Page.loadEventFired"'), null)
  assert.equal(scanCdpEnvelope('{"params":[}],"method":"Page.loadEventFired"}'), null)
})

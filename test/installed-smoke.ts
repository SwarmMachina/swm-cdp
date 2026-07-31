import assert from 'node:assert/strict'

import connect, { CdpError, closeTarget, createTarget, list, spawnChrome, version } from '@swarmmachina/swm-cdp'
import * as discovery from '@swarmmachina/swm-cdp/discovery'

assert.equal(typeof connect, 'function')
assert.equal(typeof CdpError, 'function')
assert.equal(typeof list, 'function')
assert.equal(typeof version, 'function')
assert.equal(typeof createTarget, 'function')
assert.equal(typeof closeTarget, 'function')
assert.equal(typeof spawnChrome, 'function')
assert.equal(discovery.list, list)
const privateSubpath = '@swarmmachina/swm-cdp/launcher'

await assert.rejects(import(privateSubpath), /Package subpath.*not defined/)

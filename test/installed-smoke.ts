import assert from 'node:assert/strict'

import connect, {
  CdpError,
  closeTarget,
  createTarget,
  findChrome,
  list,
  spawnChrome,
  version
} from '@swarmmachina/swm-cdp'
import * as discovery from '@swarmmachina/swm-cdp/discovery'
import * as finder from '@swarmmachina/swm-cdp/finder'

assert.equal(typeof connect, 'function')
assert.equal(typeof CdpError, 'function')
assert.equal(typeof list, 'function')
assert.equal(typeof version, 'function')
assert.equal(typeof createTarget, 'function')
assert.equal(typeof closeTarget, 'function')
assert.equal(typeof spawnChrome, 'function')
assert.equal(typeof findChrome, 'function')
assert.equal(discovery.list, list)
assert.equal(finder.findChrome, findChrome)
const privateSubpath = '@swarmmachina/swm-cdp/launcher'

await assert.rejects(import(privateSubpath), /Package subpath.*not defined/)

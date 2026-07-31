import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { validateBaseline } from '@swarmmachina/benchkit'

test('protocol benchmark baseline matches the benchkit schema', async () => {
  const json = JSON.parse(await fs.readFile('benchmark/baselines/protocol.json', 'utf8'))
  const validation = validateBaseline(json)

  assert.deepEqual(validation, { ok: true, errors: [] })
})

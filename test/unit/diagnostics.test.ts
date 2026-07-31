import assert from 'node:assert/strict'
import test from 'node:test'

import emitDiagnostic from '../../src/diagnostics.js'
import type { LogEntry } from '../../src/types.js'

test('emitDiagnostic adds a timestamp and uses the configured sink', () => {
  const entries: LogEntry[] = []
  const before = Date.now()

  emitDiagnostic((entry) => entries.push(entry), 'info', 'spawn', 'process.started')

  const after = Date.now()

  assert.deepEqual(entries, [{ event: 'process.started', level: 'info', scope: 'spawn', ts: entries[0]!.ts }])
  assert.ok(Number.isSafeInteger(entries[0]!.ts))
  assert.ok(entries[0]!.ts >= before)
  assert.ok(entries[0]!.ts <= after)
})

test('emitDiagnostic falls back to console and isolates sink failures', () => {
  const originalInfo = console.info
  const calls: unknown[][] = []

  console.info = (...args: unknown[]) => calls.push(args)

  try {
    emitDiagnostic(undefined, 'info', 'protocol', 'connection.created', { id: 1 })
    assert.doesNotThrow(() =>
      emitDiagnostic(
        () => {
          throw new Error('sink failed')
        },
        'info',
        'protocol',
        'connection.created'
      )
    )
  } finally {
    console.info = originalInfo
  }

  assert.deepEqual(calls, [['[swm-cdp:protocol] connection.created', { id: 1 }]])
})

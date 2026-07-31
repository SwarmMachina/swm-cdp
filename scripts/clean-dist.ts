import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const workspace = path.resolve(process.cwd())
const output = path.resolve(workspace, 'dist')

assert.equal(path.dirname(output), workspace, 'dist cleanup must stay inside the workspace')
assert.equal(path.basename(output), 'dist', 'dist cleanup target must be named dist')
fs.rmSync(output, { force: true, recursive: true })

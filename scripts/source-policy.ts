import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

interface PackageManifest {
  dependencies?: Record<string, string>
}

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as PackageManifest

assert.equal(Object.keys(packageJson.dependencies ?? {}).length, 0, 'runtime dependencies must remain empty')
assert.equal(fs.existsSync('package-lock.json'), false, 'package-lock.json is forbidden; use pnpm-lock.yaml')

for (const root of ['src', 'test', 'benchmark', 'scripts']) {
  for (const file of walk(root)) {
    if (file.includes(`${path.sep}profiles${path.sep}`) || file.includes(`${path.sep}reports${path.sep}`)) {
      continue
    }

    const extension = path.extname(file)

    assert.notEqual(extension, '.js', `${file}: JavaScript source is forbidden`)
    assert.ok(extension === '.ts' || extension === '.json', `${file}: unexpected source extension`)

    if (root === 'src' && !file.includes(`${path.sep}generated${path.sep}`)) {
      const source = fs.readFileSync(file, 'utf8')
      const disguisedClass = /export\s+default\s+function\s+create[A-Z]\w*\s*\(/

      assert.equal(
        disguisedClass.test(source),
        false,
        `${file}: stateful object owners must be explicit classes, not default create* functions`
      )
      assert.equal(
        /^(?:export\s+)?let\s+/m.test(source),
        false,
        `${file}: mutable module state must be owned by a class with private state`
      )

      const inheritance = /\bclass\s+\w+\s+extends\s+(\w+)/g

      for (const match of source.matchAll(inheritance)) {
        assert.ok(file.includes('error'), `${file}: inheritance is reserved for Error types (${match[0]})`)
      }
    }
  }
}

function* walk(root: string): Generator<string> {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)

    if (entry.isDirectory()) {
      yield* walk(file)
    } else {
      yield file
    }
  }
}

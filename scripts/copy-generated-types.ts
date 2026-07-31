import fs from 'node:fs'
import path from 'node:path'

const source = path.resolve('src/generated')
const destination = path.resolve('dist/generated')

fs.mkdirSync(destination, { recursive: true })

for (const file of ['protocol.d.ts', 'protocol-mapping.d.ts']) {
  fs.copyFileSync(path.join(source, file), path.join(destination, file))
}

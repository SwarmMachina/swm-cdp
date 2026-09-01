import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

interface ReleaseManifest {
  name?: unknown
  version?: unknown
  packageManager?: unknown
}

interface ReleaseMetadataParams {
  manifest: ReleaseManifest
  tag?: string
}

/**
 * @param {object} params
 * @param {object} params.manifest
 * @param {string|undefined} params.tag
 * @returns {{ name: string, version: string, tag: string|null }}
 */
export function verifyReleaseMetadata({ manifest, tag }: ReleaseMetadataParams): {
  name: string
  version: string
  tag: string | null
} {
  const name = manifest.name
  const version = manifest.version

  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('package.json must contain a package name')
  }

  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error(`package.json contains an invalid release version: ${String(version)}`)
  }

  if (!/^pnpm@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(manifest.packageManager ?? ''))) {
    throw new Error(`package.json must pin pnpm in packageManager, got ${String(manifest.packageManager)}`)
  }

  if (tag != null && tag !== '') {
    const expectedTag = `v${version}`

    if (tag !== expectedTag) {
      throw new Error(`release tag mismatch: expected ${expectedTag}, got ${tag}`)
    }
  }

  return { name, version, tag: tag || null }
}

/**
 * Verify release metadata and confirm pnpm-lock.yaml matches package.json.
 * @param {string|undefined} tag
 * @returns {Promise<{ name: string, version: string, tag: string|null }>}
 */
export async function verifyRepositoryRelease(tag: string | undefined): Promise<{
  name: string
  version: string
  tag: string | null
}> {
  const manifest = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8')) as ReleaseManifest

  try {
    execFileSync('pnpm', ['install', '--lockfile-only', '--frozen-lockfile', '--ignore-scripts'], {
      stdio: 'ignore'
    })
  } catch {
    throw new Error('pnpm-lock.yaml does not match package.json')
  }

  return verifyReleaseMetadata({ manifest, ...(tag !== undefined ? { tag } : {}) })
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isMain) {
  try {
    const { name, version, tag } = await verifyRepositoryRelease(process.argv[2])

    console.log(`[release] metadata verified: ${name}@${version}${tag ? ` (${tag})` : ''}`)
  } catch (error) {
    console.error(`[release] ${(error as Error).message}`)
    process.exitCode = 1
  }
}

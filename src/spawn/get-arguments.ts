import defaultFlags, { headlessFlags } from './default-flags.js'
import type { NormalizedLaunchOptions } from '../types.js'

export default function getArguments(options: NormalizedLaunchOptions): string[] {
  const argumentsList = [
    ...debuggingArguments(options),
    `--user-data-dir=${options.userDataDir}`,
    ...(options.disableDefaultArguments ? [] : defaultFlags),
    ...(options.additionalArguments ?? []),
    ...(options.headless ? headlessFlags : []),
    ...(options.url ? [options.url] : [])
  ]

  return normalizeArguments(argumentsList)
}

function debuggingArguments({ port, transport }: Pick<NormalizedLaunchOptions, 'port' | 'transport'>): string[] {
  if (transport === 'pipe') {
    return ['--remote-debugging-pipe']
  }

  return [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1']
}

function collectFeatures(argument: string, prefix: string, values: Set<string>): boolean {
  if (!argument.startsWith(prefix)) {
    return false
  }

  for (const feature of argument.slice(prefix.length).split(',')) {
    if (feature) {
      values.add(feature)
    }
  }

  return true
}

function normalizeArguments(argumentsList: string[]): string[] {
  const ordinary = new Set<string>()
  const enabledFeatures = new Set<string>()
  const disabledFeatures = new Set<string>()

  for (const argument of argumentsList) {
    if (collectFeatures(argument, '--enable-features=', enabledFeatures)) {
      continue
    }

    if (collectFeatures(argument, '--disable-features=', disabledFeatures)) {
      continue
    }

    ordinary.add(argument)
  }

  if (enabledFeatures.size > 0) {
    ordinary.add(`--enable-features=${[...enabledFeatures].join(',')}`)
  }

  if (disabledFeatures.size > 0) {
    ordinary.add(`--disable-features=${[...disabledFeatures].join(',')}`)
  }

  return [...ordinary]
}

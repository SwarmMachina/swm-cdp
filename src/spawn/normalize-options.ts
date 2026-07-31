import type { LaunchOptions, NormalizedLaunchOptions } from '../types.js'

const MiB = 1024 * 1024
const defaults: NormalizedLaunchOptions = Object.freeze({
  additionalArguments: undefined,
  attachTimeout: 60_000,
  chromeExecutable: undefined,
  cleanupUserDataDir: false,
  cwd: undefined,
  debugProtocol: false,
  debugSpawn: false,
  debugTransport: false,
  disableDefaultArguments: true,
  env: undefined,
  eventBackpressure: 'close',
  extendEnv: true,
  headless: false,
  logger: undefined,
  maxBufferedWriteBytes: 16 * MiB,
  maxEndpointBytes: 64 * 1024,
  maxMessageBytes: 64 * MiB,
  maxPendingRequests: 10_000,
  maxQueueDepth: 10_000,
  port: 0,
  protocolTimeout: 180_000,
  shutdownTimeout: 5_000,
  startupTimeout: 10_000,
  stdio: 'ignore',
  transport: 'pipe',
  url: undefined,
  userDataDir: undefined,
  userDataRoot: undefined
})

type Validator = (value: unknown, key: string) => unknown

const validators: Readonly<Record<keyof LaunchOptions, Validator>> = Object.freeze({
  additionalArguments: arrayOfStrings,
  attachTimeout: nonNegativeNumber,
  chromeExecutable: stringValue,
  cleanupUserDataDir: booleanValue,
  cwd: stringValue,
  debugProtocol: booleanValue,
  debugSpawn: booleanValue,
  debugTransport: booleanValue,
  disableDefaultArguments: booleanValue,
  env: environment,
  eventBackpressure: enumOf('close', 'drop-oldest'),
  extendEnv: booleanValue,
  headless: booleanValue,
  logger: functionValue,
  maxBufferedWriteBytes: nonNegativeInteger,
  maxEndpointBytes: positiveInteger,
  maxMessageBytes: nonNegativeInteger,
  maxPendingRequests: nonNegativeInteger,
  maxQueueDepth: nonNegativeInteger,
  port,
  protocolTimeout: nonNegativeNumber,
  shutdownTimeout: nonNegativeNumber,
  startupTimeout: nonNegativeNumber,
  stdio: enumOf('ignore', 'inherit'),
  transport: enumOf('pipe', 'ws'),
  url: stringValue,
  userDataDir: stringValue,
  userDataRoot: stringValue
})

export default function normalizeOptions(options?: LaunchOptions): NormalizedLaunchOptions {
  if (!isObject(options)) {
    throw new TypeError('options must be an object')
  }

  const result: Record<string, unknown> = { ...defaults }

  if (!options) {
    return result as unknown as NormalizedLaunchOptions
  }

  for (const [name, value] of Object.entries(options)) {
    const key = name as keyof LaunchOptions

    if (!Object.hasOwn(validators, key)) {
      throw new TypeError(`unknown option ${key}`)
    }

    if (value !== undefined) {
      result[key] = validators[key](value, key)
    }
  }

  return result as unknown as NormalizedLaunchOptions
}

export function isObject(value: unknown) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalidOption(key: string, expected: string): never {
  throw new TypeError(`invalid option ${key} expected value to be ${expected}`)
}

function booleanValue(value: unknown, key: string): boolean {
  return typeof value === 'boolean' ? value : invalidOption(key, 'boolean')
}

function stringValue(value: unknown, key: string): string {
  return typeof value === 'string' ? value : invalidOption(key, 'string')
}

function functionValue(value: unknown, key: string): (...args: never[]) => unknown {
  return typeof value === 'function' ? (value as (...args: never[]) => unknown) : invalidOption(key, 'function')
}

function environment(value: unknown, key: string): Record<string, string | undefined> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidOption(key, 'an environment object')
  }

  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' && entry !== undefined) {
      return invalidOption(key, `an environment object; ${name} must be a string or undefined`)
    }
  }

  return { ...value } as Record<string, string | undefined>
}

function nonNegativeNumber(value: unknown, key: string): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : invalidOption(key, 'a non-negative finite number')
}

function nonNegativeInteger(value: unknown, key: string): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : invalidOption(key, 'a non-negative safe integer')
}

function positiveInteger(value: unknown, key: string): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : invalidOption(key, 'a positive safe integer')
}

function port(value: unknown, key: string): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 65_535
    ? value
    : invalidOption(key, 'an integer between 0 and 65535')
}

function arrayOfStrings(value: unknown, key: string): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? [...value]
    : invalidOption(key, 'string[]')
}

function enumOf<const Values extends readonly string[]>(
  ...values: Values
): (value: unknown, key: string) => Values[number] {
  return (value, key) =>
    typeof value === 'string' && values.includes(value)
      ? (value as Values[number])
      : invalidOption(key, values.map((entry) => JSON.stringify(entry)).join(' | '))
}

import { performance } from 'node:perf_hooks'
import { type BatchLatencyInput, BoundedLatencyRecorder } from '@swarmmachina/benchkit/measurement'
import { parseArgs } from '@swarmmachina/benchkit/orchestration'
import { createBenchmarkArtifact, writeBenchmarkArtifact } from '@swarmmachina/benchkit/results'
import type RemoteConnection from '../src/cdp/connection/remote-connection.js'
import spawnChrome from '../src/spawn/spawn-chrome.js'
import { type BenchmarkMeasurement, measure, optionalString, positiveInteger, printReport } from './measure.js'

interface ChromeBenchmarkOptions {
  iterations: number
  concurrency: number
  warmup: number
  transport: 'pipe' | 'ws' | 'both'
  output?: string
}

const argumentOffset = process.argv[2] === '--' ? 3 : 2
const {
  iterations,
  concurrency,
  warmup,
  transport: selectedTransport,
  output
} = parseArgs<ChromeBenchmarkOptions>(
  process.argv.slice(argumentOffset),
  { iterations: 10_000, concurrency: 32, warmup: 1_000, transport: 'both' },
  {
    '--iterations': (options, value) => {
      options.iterations = positiveInteger(value, '--iterations')
    },
    '--concurrency': (options, value) => {
      options.concurrency = positiveInteger(value, '--concurrency')
    },
    '--warmup': (options, value) => {
      options.warmup = positiveInteger(value, '--warmup')
    },
    '--transport': (options, value) => {
      if (value !== 'pipe' && value !== 'ws' && value !== 'both') {
        throw new TypeError('--transport must be pipe, ws, or both')
      }

      options.transport = value
    },
    '--output': (options, value) => {
      options.output = optionalString(value, '--output')
    }
  },
  { strict: true }
)
const transports: ('pipe' | 'ws')[] = selectedTransport === 'both' ? ['pipe', 'ws'] : [selectedTransport]

async function runEvaluations(
  cdp: RemoteConnection,
  sessionId: string,
  count: number,
  parallelism: number,
  collectSamples: boolean
): Promise<BatchLatencyInput> {
  const latency = collectSamples ? new BoundedLatencyRecorder({ lowestDiscernibleMs: 0.000_001 }) : null

  let next = 0

  async function worker(): Promise<void> {
    while (next < count) {
      next++
      const startedAt = collectSamples ? performance.now() : 0

      await cdp.send('Runtime.evaluate', { expression: '1' }, sessionId)

      if (latency) {
        latency.record(performance.now() - startedAt)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(parallelism, count) }, () => worker()))

  return latency?.snapshot() ?? []
}

async function benchmarkTransport(
  transport: 'pipe' | 'ws'
): Promise<{ browser: string; result: BenchmarkMeasurement }> {
  let chrome = null

  try {
    chrome = spawnChrome({
      chromeExecutable: process.env.CHROME_PATH,
      transport,
      port: 0,
      disableDefaultArguments: false,
      headless: true,
      url: 'about:blank',
      startupTimeout: 15_000,
      attachTimeout: 15_000,
      protocolTimeout: 10_000,
      shutdownTimeout: 5_000,
      maxPendingRequests: Math.max(1_000, concurrency * 2)
    })

    const cdp = await chrome.attach()
    const version = await cdp.send('Browser.getVersion')
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { flatten: true, targetId: target.targetId })

    await cdp.send('Runtime.enable', undefined, sessionId)
    await runEvaluations(cdp, sessionId, warmup, concurrency, false)

    const result = await measure(`${transport} Runtime.evaluate`, iterations, concurrency, () =>
      runEvaluations(cdp, sessionId, iterations, concurrency, true)
    )

    return { browser: version.product, result }
  } finally {
    await chrome?.dispose()
  }
}

const measured: { browser: string; result: BenchmarkMeasurement }[] = []

for (const transport of transports) {
  measured.push(await benchmarkTransport(transport))
}

const results = measured.map(({ result }) => result)
const parameters = `connections=1 iterations=${iterations} warmup=${warmup} request-pipelining=${concurrency} transports=${transports.join(',')}`

printReport(results, parameters)

if (output) {
  await writeBenchmarkArtifact(
    output,
    createBenchmarkArtifact({
      suite: 'chrome',
      parameters: { connections: 1, iterations, transports, warmup, requestPipelining: concurrency },
      metadata: {
        browsers: Object.fromEntries(measured.map(({ browser }, index) => [transports[index], browser]))
      },
      results
    })
  )
}

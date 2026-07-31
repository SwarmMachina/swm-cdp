import { performance } from 'node:perf_hooks'
import { BoundedLatencyRecorder, type BatchLatencyInput } from '@swarmmachina/benchkit/measurement'
import { parseArgs } from '@swarmmachina/benchkit/orchestration'
import { createBenchmarkArtifact, writeBenchmarkArtifact } from '@swarmmachina/benchkit/results'
import Connection from '../src/cdp/connection/connection.js'
import LoopbackTransport from './loopback-transport.js'
import { measure, optionalString, positiveInteger, printReport, type BenchmarkMeasurement } from './measure.js'

interface ProtocolOptions {
  iterations: number
  concurrency: number
  warmup: number
  output?: string
}

const argumentOffset = process.argv[2] === '--' ? 3 : 2
const { iterations, concurrency, warmup, output } = parseArgs<ProtocolOptions>(
  process.argv.slice(argumentOffset),
  { iterations: 50_000, concurrency: 128, warmup: 5_000 },
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
    '--output': (options, value) => {
      options.output = optionalString(value, '--output')
    }
  },
  { strict: true }
)

async function runRequests(
  root: Connection,
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

      await root.send('Runtime.evaluate', { expression: '1' })

      if (latency) {
        latency.record(performance.now() - startedAt)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(parallelism, count) }, () => worker()))

  return latency?.snapshot() ?? []
}

async function benchmarkRequests(): Promise<BenchmarkMeasurement> {
  const transport = new LoopbackTransport(Math.max(10_000, concurrency * 2))
  const root = new Connection(transport)

  await runRequests(root, warmup, concurrency, false)

  const result = await measure('request/response', iterations, concurrency, () =>
    runRequests(root, iterations, concurrency, true)
  )

  root.detach()

  return result
}

async function benchmarkSessionEvents(): Promise<BenchmarkMeasurement> {
  const transport = new LoopbackTransport(Math.max(10_000, concurrency * 2))
  const root = new Connection(transport)

  root.onTransportMessage(
    JSON.stringify({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'benchmark-session',
        targetInfo: { targetId: 'benchmark-target' }
      }
    })
  )

  const session = root.getConnection({ targetId: 'benchmark-target' }, true)

  session.on('Runtime.consoleAPICalled', () => {})
  const message = JSON.stringify({
    method: 'Runtime.consoleAPICalled',
    params: { type: 'log' },
    sessionId: 'benchmark-session'
  })

  for (let index = 0; index < warmup; index++) {
    root.onTransportMessage(message)
  }

  const result = await measure('session event', iterations, 1, () => {
    const latency = new BoundedLatencyRecorder({ lowestDiscernibleMs: 0.000_001 })

    for (let index = 0; index < iterations; index++) {
      const startedAt = performance.now()

      root.onTransportMessage(message)
      latency.record(performance.now() - startedAt)
    }

    return latency.snapshot()
  })

  root.detach()

  return result
}

async function benchmarkEventStorm(subscribed: boolean): Promise<BenchmarkMeasurement> {
  const transport = new LoopbackTransport(Math.max(10_000, concurrency * 2))
  const root = new Connection(transport)
  const method = 'Network.dataReceived'
  const message = JSON.stringify({
    method,
    params: {
      dataLength: 1024,
      encodedDataLength: 1024,
      requestId: 'benchmark-request',
      timestamp: 1,
      padding: 'x'.repeat(900)
    }
  })
  const unsubscribe = subscribed ? root.on(method, () => {}) : null

  for (let index = 0; index < warmup; index++) {
    root.onTransportMessage(message)
  }

  const result = await measure(`event storm ${subscribed ? 'subscribed' : 'unsubscribed'}`, iterations, 1, () => {
    const latency = new BoundedLatencyRecorder({ lowestDiscernibleMs: 0.000_001 })

    for (let index = 0; index < iterations; index++) {
      const startedAt = performance.now()

      root.onTransportMessage(message)
      latency.record(performance.now() - startedAt)
    }

    return latency.snapshot()
  })

  unsubscribe?.()
  root.detach()

  return result
}

const results = [
  await benchmarkRequests(),
  await benchmarkSessionEvents(),
  await benchmarkEventStorm(true),
  await benchmarkEventStorm(false)
]
const parameters = `connections=1 iterations=${iterations} warmup=${warmup} request-pipelining=${concurrency}`

printReport(results, parameters)

if (output) {
  await writeBenchmarkArtifact(
    output,
    createBenchmarkArtifact({
      suite: 'protocol',
      parameters: { connections: 1, iterations, warmup, requestPipelining: concurrency },
      results
    })
  )
}

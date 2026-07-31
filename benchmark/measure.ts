import { measureScenario, type BatchLatencyInput, type ScenarioMeasurement } from '@swarmmachina/benchkit/measurement'
import { renderBatchMeasurementsMarkdown } from '@swarmmachina/benchkit/reporting'

export type BenchmarkMeasurement = ScenarioMeasurement

export function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }

  return parsed
}

export function optionalString(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string`)
  }

  return value
}

export async function measure(
  name: string,
  operations: number,
  pipelining: number,
  run: () => BatchLatencyInput | Promise<BatchLatencyInput>
): Promise<BenchmarkMeasurement> {
  return measureScenario({
    name,
    connections: 1,
    pipelining,
    operations,
    memorySampleMs: 10,
    before: async () => {
      globalThis.gc?.()
      const { resolve, promise } = Promise.withResolvers<void>()

      setImmediate(resolve)
      await promise
    },
    run
  })
}

export function printReport(results: readonly BenchmarkMeasurement[], parameters: string): void {
  console.log(renderBatchMeasurementsMarkdown(results, { parameters }))
}

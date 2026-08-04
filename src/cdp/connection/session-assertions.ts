import type { TargetInfo } from '../../types.js'

export function assertSessionId(value: unknown, label = 'Session id'): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
}

export function assertTargetInfo(value: unknown): asserts value is TargetInfo {
  if (
    !value ||
    typeof value !== 'object' ||
    !('targetId' in value) ||
    typeof value.targetId !== 'string' ||
    value.targetId.length === 0
  ) {
    throw new TypeError('Target info must contain a non-empty target id')
  }
}

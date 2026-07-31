export const newLineRegex = /\r?\n/

export function escapeRegex(value: string): string {
  if (typeof value !== 'string') {
    throw new TypeError('Expected a string')
  }

  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&').replaceAll('-', '\\x2d')
}

export interface PathPriority {
  regex: RegExp
  weight: number
}

export function sortByPriority(paths: string[], priorities: PathPriority[], defaultWeight = 10): string[] {
  return paths
    .map((path, index) => ({ index, path, weight: pathWeight(path, priorities, defaultWeight) }))
    .sort((left, right) => right.weight - left.weight || left.index - right.index)
    .map(({ path }) => path)
}

function pathWeight(path: string, priorities: PathPriority[], fallback: number): number {
  for (const { regex, weight } of priorities) {
    if (regex.test(path)) {
      return weight
    }
  }

  return fallback
}

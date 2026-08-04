export interface CdpEnvelope {
  method?: string
  sessionId?: string
}

/**
 * Extract routing fields without allocating the full JSON object. The scan
 * still walks the complete envelope so truncated messages fall back to the
 * strict JSON.parse error path.
 */
export default function scanCdpEnvelope(json: string): CdpEnvelope | null {
  let index = skipWhitespace(json, 0)

  if (json.charCodeAt(index++) !== 0x7b) {
    return null
  }

  const envelope: CdpEnvelope = {}

  index = skipWhitespace(json, index)

  if (json.charCodeAt(index) === 0x7d) {
    return envelope
  }

  while (index < json.length) {
    const key = readString(json, index)

    if (!key) {
      return null
    }

    index = skipWhitespace(json, key.end)

    if (json.charCodeAt(index++) !== 0x3a) {
      return null
    }

    index = skipWhitespace(json, index)

    if (key.value === 'method' || key.value === 'sessionId') {
      const value = readString(json, index)

      if (!value) {
        return null
      }

      if (key.value === 'method') {
        envelope.method = value.value
      } else {
        envelope.sessionId = value.value
      }

      index = value.end
    } else {
      index = skipValue(json, index)

      if (index < 0) {
        return null
      }
    }

    index = skipWhitespace(json, index)
    const separator = json.charCodeAt(index++)

    if (separator === 0x7d) {
      return skipWhitespace(json, index) === json.length ? envelope : null
    }

    if (separator !== 0x2c) {
      return null
    }

    index = skipWhitespace(json, index)
  }

  return null
}

function skipWhitespace(value: string, index: number): number {
  while (index < value.length) {
    const code = value.charCodeAt(index)

    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      break
    }

    index++
  }

  return index
}

function readString(value: string, index: number): { end: number; value: string } | null {
  if (value.charCodeAt(index) !== 0x22) {
    return null
  }

  const start = ++index

  let escaped = false

  while (index < value.length) {
    const code = value.charCodeAt(index)

    if (code === 0x22) {
      const raw = value.slice(start, index)

      try {
        return { end: index + 1, value: escaped ? (JSON.parse(`"${raw}"`) as string) : raw }
      } catch {
        return null
      }
    }

    if (code === 0x5c) {
      escaped = true
      index += 2
    } else {
      if (code < 0x20) {
        return null
      }

      index++
    }
  }

  return null
}

function skipValue(value: string, index: number): number {
  const first = value.charCodeAt(index)

  if (first === 0x22) {
    return readString(value, index)?.end ?? -1
  }

  if (first === 0x7b || first === 0x5b) {
    return skipComposite(value, index)
  }

  while (index < value.length) {
    const code = value.charCodeAt(index)

    if (code === 0x2c || code === 0x7d) {
      break
    }

    index++
  }

  return index
}

function skipComposite(value: string, index: number): number {
  const stack: number[] = [value.charCodeAt(index++)]

  while (index < value.length && stack.length > 0) {
    const code = value.charCodeAt(index)

    if (code === 0x22) {
      const string = readString(value, index)

      if (!string) {
        return -1
      }

      index = string.end
      continue
    }

    if (code === 0x7b || code === 0x5b) {
      stack.push(code)
    } else if (code === 0x7d) {
      if (stack.pop() !== 0x7b) {
        return -1
      }
    } else if (code === 0x5d) {
      if (stack.pop() !== 0x5b) {
        return -1
      }
    }

    index++
  }

  return stack.length === 0 ? index : -1
}

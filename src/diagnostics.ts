import type { LogEntry, LogLevel, LogScope, LogSink } from './types.js'

const consoleSink: LogSink = ({ data, event, level, scope }) => {
  const prefix = `[swm-cdp:${scope}] ${event}`

  if (data === undefined) {
    console[level](prefix)
  } else {
    console[level](prefix, data)
  }
}

/** Delivers one diagnostic record to the configured sink or to `console`. */
export default function emitDiagnostic(
  sink: LogSink | undefined,
  level: LogLevel,
  scope: LogScope,
  event: string,
  data?: unknown
): void {
  const ts = Date.now()
  const entry: LogEntry = data === undefined ? { event, level, scope, ts } : { data, event, level, scope, ts }
  const destination = sink ?? consoleSink

  try {
    destination(entry)
  } catch {
    // Diagnostics must not alter runtime control flow.
  }
}

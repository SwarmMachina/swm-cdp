# @swarmmachina/swm-cdp

[![CI](https://github.com/SwarmMachina/swm-cdp/actions/workflows/ci.yml/badge.svg)](https://github.com/SwarmMachina/swm-cdp/actions/workflows/ci.yml)
[![License: MPL 2.0](https://img.shields.io/badge/License-MPL%202.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![Node.js](https://img.shields.io/badge/node-22%20%7C%2024-brightgreen.svg)](https://nodejs.org/)
[![runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-brightgreen.svg)](#runtime-design)
[![stability](https://img.shields.io/badge/stability-experimental-orange.svg)](#stability)

Zero-dependency, ESM-only Chrome DevTools Protocol client for Node.js 22 and 24.

`swm-cdp` exposes a deliberately small API for typed CDP commands and events, flattened sessions, Chrome process ownership, and HTTP discovery. It uses the WebSocket client built into Node.js and accepts browser-level WebSocket connections only on explicit loopback IP addresses.

## Features

- Statically typed CDP commands, parameters, results, events, and payloads.
- Browser-level WebSocket connections restricted to `127.0.0.1` and `[::1]`.
- Owned Chrome lifecycle with explicit process creation, attachment, shutdown, and cleanup stages.
- Pipe and WebSocket transports for launched Chrome processes.
- Flattened CDP session support without runtime domain-object generation.
- Bounded pending requests, task queues, payloads, endpoint output, and outbound buffers.
- Configurable event backpressure with fail-closed behavior by default.
- Structured diagnostics without an `EventEmitter` in the protocol hot path.
- Zero runtime dependencies and no runtime protocol schema loading.

## Installation

```bash
pnpm add @swarmmachina/swm-cdp
```

### Runtime requirements

- Node.js `^22.13.0` or 24.x.
- Native ESM.
- A locally installed Chrome or Chromium executable when using `spawnChrome()`.
- The built-in Node.js `WebSocket`; runtimes started with `--no-experimental-websocket` are not supported.

`connect()` treats the CDP endpoint as a trusted local boundary. It accepts only the literal hosts `127.0.0.1` and `[::1]`; `localhost`, DNS names, Unix sockets, and remote addresses are intentionally rejected.

## Quick Start

The examples below are the canonical usage model: `connect()` owns one remote client connection, while `spawnChrome()` owns both Chrome and its client. Both paths expose the same typed `CdpClient` facade.

### Connect to Running Chrome

Start Chrome with a loopback debugging endpoint, then connect to its browser-level WebSocket:

```ts
import connect from '@swarmmachina/swm-cdp'

const cdp = await connect({ host: '127.0.0.1', port: 9222 })

try {
  const version = await cdp.send('Browser.getVersion')
  console.log(version.product)
} finally {
  await cdp.close()
}
```

`cdp.close()` closes only this client connection. It does not terminate a Chrome process that the caller started independently.

### Launch Owned Chrome

```ts
import { spawnChrome } from '@swarmmachina/swm-cdp'

const browser = spawnChrome({
  chromeExecutable: process.env.CHROME_PATH,
  disableDefaultArguments: false,
  headless: true,
  transport: 'pipe'
})

try {
  const cdp = await browser.attach()
  const version = await cdp.send('Browser.getVersion')
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    flatten: true,
    targetId: target.targetId
  })

  await cdp.send('Runtime.enable', undefined, sessionId)
  const consoleEvent = cdp.once('Runtime.consoleAPICalled')

  await cdp.send('Runtime.evaluate', { expression: "console.log('ready')" }, sessionId)
  console.log(version.product, (await consoleEvent).type)
} finally {
  await browser.close()
}
```

`spawnChrome()` creates the process synchronously and returns its lifecycle owner. `browser.attach()` is the explicit asynchronous readiness stage. Closing the client returned by `browser.attach()` delegates to `browser.close()` and therefore also shuts down the owned Chrome process.

### Commands, Events, and Sessions

The launch example is also the reference for commands, events, and flattened sessions. `send()` accepts a generated CDP method and payload, `once()` waits for one generated event, and the optional `sessionId` is written to the flattened CDP envelope. Persistent `on()` listeners return an unsubscribe function and receive `sessionId` as their second argument.

Keep the returned function and call it when the subscription is no longer needed:

```ts
await cdp.send('Runtime.enable', undefined, sessionId)

const unsubscribe = cdp.on('Runtime.consoleAPICalled', (event, eventSessionId) => {
  if (eventSessionId === sessionId) {
    console.log(event.type, event.args)
  }
})

try {
  await cdp.send('Runtime.evaluate', { expression: "console.log('ready')" }, sessionId)
} finally {
  unsubscribe()
}
```

Calling `unsubscribe()` more than once is safe.

### Discovery

```ts
import { closeTarget, createTarget, list, version } from '@swarmmachina/swm-cdp'

const endpoint = { host: '127.0.0.1', port: 9222 }
const browserVersion = await version(endpoint)
const targets = await list(endpoint)
const target = await createTarget(endpoint, 'about:blank')

console.log(browserVersion.webSocketDebuggerUrl, targets.length)
await closeTarget(target.id, endpoint)
```

Discovery uses `node:http` and `node:https`; it does not require an open CDP client.

## API Documentation

Short API fragments in this section use the `cdp` client created in Quick Start; they refine that model rather than introduce a second usage pattern.

### `connect(target, options?)`

Opens a browser-level CDP WebSocket and resolves after the handshake succeeds.

Accepted target forms:

| Target                                     | Meaning                                            |
| ------------------------------------------ | -------------------------------------------------- |
| `'ws://127.0.0.1:9222/devtools/browser/…'` | Complete browser-level CDP URL                     |
| `new URL('ws://[::1]:9222/devtools/…')`    | Complete IPv6 loopback URL                         |
| `{ url: string \| URL }`                   | Complete URL wrapped in an object                  |
| `{ host?, port?, secure? }`                | Endpoint description; defaults to `127.0.0.1:9222` |

Only `ws:` and `wss:` are accepted. The host must be exactly `127.0.0.1` or `[::1]`.

`ConnectOptions`:

| Option                  | Default   | Description                                               |
| ----------------------- | --------- | --------------------------------------------------------- |
| `attachTimeout`         | `60_000`  | WebSocket handshake deadline in milliseconds.             |
| `debugProtocol`         | `false`   | Emit CDP request, response, and event diagnostics.        |
| `debugTransport`        | `false`   | Emit transport lifecycle and message diagnostics.         |
| `eventBackpressure`     | `'close'` | Queue overflow policy: `'close'` or `'drop-oldest'`.      |
| `logger`                | `console` | Structured diagnostic callback.                           |
| `maxBufferedWriteBytes` | `16 MiB`  | Maximum queued outbound transport bytes.                  |
| `maxMessageBytes`       | `64 MiB`  | Maximum encoded CDP message size accepted by the library. |
| `maxPendingRequests`    | `10_000`  | Maximum commands awaiting responses.                      |
| `maxQueueDepth`         | `10_000`  | Maximum queued transport tasks.                           |
| `protocolTimeout`       | `180_000` | Default command and event-wait deadline in milliseconds.  |

Invalid targets and unknown or invalid options throw `TypeError` before attachment.

### `CdpClient`

`connect()` and `browser.attach()` return the same typed client facade.

| Member                                        | Description                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `closed`                                      | Whether the underlying connection reached its terminal state.          |
| `send(method, params?, sessionId?, options?)` | Send a typed command and resolve with its typed result.                |
| `on(event, listener)`                         | Subscribe to a typed event and return an unsubscribe function.         |
| `once(event)`                                 | Resolve with the next typed event payload.                             |
| `once(event, listener)`                       | Register a one-shot listener and return an unsubscribe function.       |
| `onClose(listener)`                           | Observe connection closure outside the CDP event namespace.            |
| `onError(listener)`                           | Observe transport and protocol errors outside the CDP event namespace. |
| `close()`                                     | Close the client; repeated calls return the same promise.              |

`send()` supports per-operation cancellation and deadlines:

```ts
const controller = new AbortController()

const result = await cdp.send(
  'Runtime.evaluate',
  { expression: 'globalThis.location.href', returnByValue: true },
  'page-session-id',
  { signal: controller.signal, timeout: 5_000 }
)
```

For commands without parameters, pass `undefined` before `sessionId` or operation options. Unknown protocol extensions can be called with an explicit result type:

```ts
const result = await cdp.send<{ value: string }>('Vendor.customMethod', { key: 'value' })
```

CDP failures reject with `CdpError`. Transport failures and local validation errors reject with ordinary `Error` subclasses.

### `spawnChrome(options?)`

Starts a Chrome process owned by the returned `Browser`. When no `userDataDir` is supplied, a temporary profile is created and removed after process exit.

Process and profile options:

| Option                    | Default       | Description                                               |
| ------------------------- | ------------- | --------------------------------------------------------- |
| `chromeExecutable`        | auto-detected | Chrome or Chromium executable path.                       |
| `additionalArguments`     | `[]`          | Chrome arguments appended after package arguments.        |
| `disableDefaultArguments` | `true`        | Disable the package's default Chrome flags.               |
| `headless`                | `false`       | Add the package's headless flags.                         |
| `url`                     | `undefined`   | Initial URL opened by Chrome.                             |
| `cwd`                     | `undefined`   | Chrome process working directory.                         |
| `env`                     | `undefined`   | Environment overrides; `undefined` removes a key.         |
| `extendEnv`               | `true`        | Extend `process.env`; when false, use only `env`.         |
| `stdio`                   | `'ignore'`    | Chrome stdout and stderr mode: `'ignore'` or `'inherit'`. |
| `userDataDir`             | temporary     | Existing Chrome profile directory.                        |
| `userDataRoot`            | OS temp dir   | Parent directory for an automatically created profile.    |
| `cleanupUserDataDir`      | `false`       | Remove a caller-supplied profile after exit.              |

Transport and lifecycle options:

| Option                  | Default   | Description                                               |
| ----------------------- | --------- | --------------------------------------------------------- |
| `transport`             | `'pipe'`  | `'pipe'`, `'ws'`.                                         |
| `port`                  | `0`       | WebSocket debugging port; `0` asks Chrome to choose one.  |
| `startupTimeout`        | `10_000`  | Deadline for Chrome to report its WebSocket endpoint.     |
| `attachTimeout`         | `60_000`  | WebSocket handshake deadline in milliseconds.             |
| `protocolTimeout`       | `180_000` | Default command and event-wait deadline in milliseconds.  |
| `shutdownTimeout`       | `5_000`   | Graceful shutdown budget in milliseconds.                 |
| `maxEndpointBytes`      | `64 KiB`  | Maximum size of the stderr line containing the endpoint.  |
| `maxBufferedWriteBytes` | `16 MiB`  | Maximum queued outbound transport bytes.                  |
| `maxMessageBytes`       | `64 MiB`  | Maximum encoded CDP message size accepted by the library. |
| `maxPendingRequests`    | `10_000`  | Maximum commands awaiting responses.                      |
| `maxQueueDepth`         | `10_000`  | Maximum queued transport tasks.                           |
| `eventBackpressure`     | `'close'` | Queue overflow policy: `'close'` or `'drop-oldest'`.      |

Diagnostic options:

| Option           | Default   | Description                                     |
| ---------------- | --------- | ----------------------------------------------- |
| `logger`         | `console` | Receives structured `LogEntry` records.         |
| `debugSpawn`     | `false`   | Emit process and profile lifecycle diagnostics. |
| `debugTransport` | `false`   | Emit transport diagnostics.                     |
| `debugProtocol`  | `false`   | Emit protocol diagnostics.                      |

Unknown or invalid options throw `TypeError`. Chrome discovery and process-start failures throw `Error`.

### `Browser`

`Browser` is a single-use lifecycle owner with the states `created`, `attaching`, `open`, `closing`, and `closed`.

| Property        | Description                                           |
| --------------- | ----------------------------------------------------- |
| `args`          | Arguments passed to Chrome, excluding the executable. |
| `attached`      | Whether the CDP transport is attached and open.       |
| `chromeProcess` | Underlying Node.js child-process handle, or `null`.   |
| `closed`        | Whether the lifecycle reached its terminal state.     |
| `command`       | Resolved Chrome executable path.                      |
| `connection`    | Attached `CdpClient`, or `null` before attachment.    |
| `error`         | Transport failure that initiated cleanup, if any.     |
| `isExited`      | Whether the Chrome process exited.                    |
| `lastError`     | Most recent process-management error, if any.         |
| `pid`           | Chrome process identifier, when available.            |
| `state`         | Current lifecycle state.                              |
| `transport`     | Active CDP transport, or `null` before attachment.    |
| `userDataDir`   | Chrome profile directory used by the process.         |

| Method                            | Description                                                            |
| --------------------------------- | ---------------------------------------------------------------------- |
| `attach()`                        | Attach once and return the client; concurrent calls share one promise. |
| `close(timeout?)`                 | Gracefully close Chrome, then kill it if the deadline expires.         |
| `dispose(timeout?)`               | Alias for `close()`.                                                   |
| `kill(timeout?)`                  | Terminate Chrome without sending `Browser.close`.                      |
| `waitForExit(timeout?)`           | Wait for the owned process to exit.                                    |
| `on(event, listener)`             | Subscribe to `'error'` or `'exit'`; returns an unsubscribe function.   |
| `once(event, listener)`           | Register a one-shot lifecycle listener.                                |
| `removeListener(event, listener)` | Remove a lifecycle listener.                                           |
| `listenerCount(event)`            | Return the number of listeners for an event.                           |

`close()` is idempotent. If attachment fails, the browser terminates the process and cleans an automatically created profile before rejecting.

### Discovery API

Discovery targets accept an `http:`, `https:`, `ws:`, or `wss:` URL, `{ url }`, or `{ host?, port?, secure? }`. WebSocket schemes are converted to their HTTP equivalents. Object targets default to `127.0.0.1:9222`.

| Function                                | Description                                 |
| --------------------------------------- | ------------------------------------------- |
| `list(target?, options?)`               | Read target metadata from `/json/list`.     |
| `version(target?, options?)`            | Read browser metadata from `/json/version`. |
| `createTarget(target?, url?, options?)` | Create a target through `/json/new`.        |
| `closeTarget(id, target?, options?)`    | Close a target through `/json/close/:id`.   |

`DiscoveryOptions`:

| Option             | Default  | Description                       |
| ------------------ | -------- | --------------------------------- |
| `maxResponseBytes` | `8 MiB`  | Maximum response body size.       |
| `timeout`          | `10_000` | Request deadline in milliseconds. |

The same functions and discovery types are available from `@swarmmachina/swm-cdp/discovery`.

### Diagnostics

Enabled diagnostics are written to `console` by default. Configure `logger` with a `LogSink` callback to receive
structured `LogEntry` records instead:

```ts
import connect, { type LogSink } from '@swarmmachina/swm-cdp'

const logger: LogSink = (entry) => {
  process.stderr.write(`${JSON.stringify(entry)}\n`)
}

const cdp = await connect({
  host: '127.0.0.1',
  port: 9222,
  debugProtocol: true,
  debugTransport: true,
  logger
})

try {
  await cdp.send('Browser.getVersion')
} finally {
  await cdp.close()
}
```

The `debugProtocol`, `debugTransport`, and `debugSpawn` flags enable diagnostics for their respective scopes.

| Field   | Type                                      | Description                      |
| ------- | ----------------------------------------- | -------------------------------- |
| `time`  | `number`                                  | Unix timestamp in milliseconds.  |
| `level` | `'debug' \| 'info' \| 'warn' \| 'error'`  | Event severity.                  |
| `scope` | `'spawn' \| 'pipe' \| 'ws' \| 'protocol'` | Runtime subsystem.               |
| `event` | `string`                                  | Stable dot-separated event name. |
| `data`  | `unknown`                                 | Optional event-specific payload. |

### Error Handling

```ts
import { CdpError } from '@swarmmachina/swm-cdp'

try {
  await cdp.send('Vendor.invalidMethod')
} catch (error) {
  if (CdpError.isCdpError(error)) {
    console.error(error.code, error.message, error.data, error.request)
  } else {
    throw error
  }
}
```

`CdpError` preserves the original request, numeric CDP error code, optional error data, and raw response.

## Resource Limits and Backpressure

| Limit                   | Default  | Failure behavior                                                  |
| ----------------------- | -------- | ----------------------------------------------------------------- |
| Pending requests        | `10_000` | Reject new commands after the limit is reached.                   |
| Transport task queue    | `10_000` | Close the transport, or drop eligible events under `drop-oldest`. |
| Outbound buffered bytes | `16 MiB` | Reject or close when queued writes exceed the limit.              |
| CDP message bytes       | `64 MiB` | Close the transport when the encoded message exceeds the limit.   |
| Endpoint stderr bytes   | `64 KiB` | Fail WebSocket endpoint discovery.                                |
| Discovery response body | `8 MiB`  | Destroy the discovery request.                                    |

`eventBackpressure: 'drop-oldest'` drops only ordinary notifications. Responses and target lifecycle events are retained so request completion and flattened-session state remain coherent.

The Node.js WebSocket implementation reconstructs an incoming WebSocket message before `maxMessageBytes` can be applied. The local-only endpoint restriction is therefore part of the memory-safety boundary: do not forward an untrusted remote CDP endpoint onto an accepted loopback address.

## Runtime Design

- Stateful owners and lifecycle components are explicit classes: `Browser`, connection, transports, process owner, user-data directory, Chrome finder, request dispatcher, session registry, and event registry.
- Pure normalization, validation, protocol scanning, diagnostic delivery, and argument transformations remain functions.
- Mutable module-level state is rejected by the source-policy check; caches belong to their owning class.
- An `id -> pending` `Map` gives response dispatch constant-time lookup.
- A selective envelope scanner skips `JSON.parse` for events with no subscribers while retaining target lifecycle events required for flattened sessions.
- The WebSocket transport uses the client built into Node.js; this package owns attachment, bounds, queueing, validation, and shutdown.
- The generated static protocol map provides editor completion and compile-time checking without loading `protocol.json` at runtime.
- No runtime dependencies and no `EventEmitter` in protocol dispatch.

The implementation uses inheritance only for the normal `Error` hierarchy.

## Migration from chrome-remote-interface

There is intentionally no dynamic-domain compatibility layer.

| chrome-remote-interface                         | `@swarmmachina/swm-cdp`                              |
| ----------------------------------------------- | ---------------------------------------------------- |
| `const client = await CDP()`                    | `const cdp = await connect({ host, port })`          |
| `await client.Network.enable()`                 | `await cdp.send('Network.enable')`                   |
| `await client.Runtime.evaluate({ expression })` | `await cdp.send('Runtime.evaluate', { expression })` |
| `client.Page.loadEventFired(cb)`                | `const off = cdp.on('Page.loadEventFired', cb)`      |
| `client.send(method, params, sessionId)`        | `cdp.send(method, params, sessionId)`                |
| `await client.close()`                          | `await cdp.close()`                                  |

Use `chrome-remote-interface` when dynamic domain objects are more valuable than cold-start cost, dependency count, or event-storm throughput. It is mature and convenient for exploratory scripts. `swm-cdp` targets typed services and high-volume CDP workloads where a minimal API and predictable hot path matter.

## Performance Status

The committed protocol and Chrome transport scenarios use `@swarmmachina/benchkit` 0.3 for bounded latency histograms, throughput, p95/p99 latency, event-loop utilization, memory deltas, and process-memory peaks. Regression thresholds remain disabled until repeated calibration runs complete on the dedicated `swm-ci/bench` runner. This table intentionally contains no invented numbers.

| Scenario                        |             swm-cdp |                 CRI | puppeteer-core CDPSession |
| ------------------------------- | ------------------: | ------------------: | ------------------------: |
| Command RTT, in-flight 1/32/256 | calibration pending | calibration pending |                         — |
| Subscribed event storm          | calibration pending | calibration pending |       calibration pending |
| Unsubscribed event storm        | calibration pending | calibration pending |       calibration pending |
| Payloads 1/8/32 MiB             | calibration pending | calibration pending |       calibration pending |
| 80% events / 20% commands       | calibration pending | calibration pending |       calibration pending |
| Connect and cold import         | calibration pending | calibration pending |                         — |
| 60-second soak                  | calibration pending | calibration pending |       calibration pending |

## Testing

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run source-policy
pnpm run release:gate
```

Focused commands:

```bash
pnpm run test:unit
pnpm run test:coverage
pnpm run test:leak
pnpm run test:e2e
pnpm run bench:protocol -- --iterations 50000 --warmup 5000 --concurrency 128
pnpm run bench:chrome -- --iterations 10000 --warmup 1000 --concurrency 32 --transport both
```

Both benchmark commands print a Markdown report containing throughput, p95/p99 latency, ELU, and memory measurements under the fixed parameters shown above. The unit suite covers protocol interleaving and sessions, request cleanup, native WebSocket integration, selective scanning, spawn cleanup, and discovery. The Chrome e2e suite covers both transports, concurrent flattened sessions, timeout recovery, pending-request pressure, discovery target lifecycle, reconnect, graceful shutdown, and unexpected process exit. The release gate adds strict TypeScript checks for source, tests, scripts, benchmarks, and public contracts, plus leak checks, profiling, and build verification. CI also packages and smoke-tests the tarball, runs supported Node.js versions, and exercises a pinned headless Chrome container, including a differential check against CRI.

## Release

Version tags matching `v*` publish only after CI builds the package, installs the exact tarball into a clean consumer project, and passes its smoke test. The first `v0.1.0` publication uses the repository npm token; later releases use npm trusted publishing.

## Stability

The package is currently experimental. Public types and runtime behavior may change before a stable release; changes should be documented and covered by consumer type contracts.

## Contributing

Run `pnpm run release:gate` before opening a pull request. Keep runtime dependencies at zero unless a measured, documented benefit justifies changing that constraint.

## License

[MPL-2.0](./LICENSE). Generated Chrome DevTools Protocol declarations retain their Chromium BSD license headers.

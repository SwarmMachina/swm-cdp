import CdpError from './cdp/cdp-error.js'
import connect from './cdp/connect.js'
import { closeTarget, createTarget, list, version } from './discovery.js'
import spawnChrome from './spawn/spawn-chrome.js'

export type { RemoteConnection as CdpClient } from './cdp/connection/remote-connection.js'
export type {
  ConnectOptions,
  ConnectTarget,
  LaunchOptions,
  LogEntry,
  LogLevel,
  LogSink,
  LogScope,
  OperationOptions
} from './types.js'
export type { BrowserVersionInfo, DiscoveryOptions, DiscoveryTarget, DiscoveryTargetInfo } from './discovery.js'
export type { Browser } from './spawn/browser.js'
export { CdpError, closeTarget, connect, createTarget, list, spawnChrome, version }
export default connect

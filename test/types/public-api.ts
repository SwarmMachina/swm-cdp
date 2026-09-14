import connect, {
  CdpError,
  ChromeFinder,
  ChromeNotInstalledError,
  closeTarget,
  type ConnectOptions,
  createTarget,
  findChrome,
  list,
  type LogSink,
  spawnChrome,
  version
} from '@swarmmachina/swm-cdp'
import * as discovery from '@swarmmachina/swm-cdp/discovery'
import * as finder from '@swarmmachina/swm-cdp/finder'

const logSink: LogSink = (entry) => {
  entry.event.toUpperCase()
}

const options: ConnectOptions = {
  logger: logSink,
  protocolTimeout: 30_000
}

async function consumer(): Promise<void> {
  const cdp = await connect({ host: '127.0.0.1', port: 9222 }, options)
  const browserVersion = await cdp.send('Browser.getVersion')

  browserVersion.product.toUpperCase()
  await cdp.send('Browser.getVersion', undefined, { timeout: 5_000 })
  await cdp.send('Page.enable')
  await cdp.send('Runtime.evaluate', { expression: '1 + 1', returnByValue: true }, 'session-1')
  cdp.on('Runtime.consoleAPICalled', (event, sessionId) => {
    event.type.toUpperCase()
    sessionId?.toUpperCase()
  })

  // @ts-expect-error Runtime.evaluate requires an expression.
  await cdp.send('Runtime.evaluate', {})
  // @ts-expect-error Browser.getVersion has no parameters.
  await cdp.send('Browser.getVersion', { unexpected: true })
  await cdp.close()
}

async function launcherConsumer(): Promise<void> {
  const browser = spawnChrome({ chromeExecutable: '/path/to/chrome', headless: true })
  const cdp = await browser.attach()
  const browserVersion = await cdp.send('Browser.getVersion')

  browserVersion.product.toUpperCase()
  await browser.close()

  // @ts-expect-error Session registry helpers are intentionally not public.
  await cdp.attachToTarget('target-id')
}

void consumer
void launcherConsumer
void CdpError
void ChromeFinder
void ChromeNotInstalledError
void closeTarget
void createTarget
void findChrome
void list
void logSink
void spawnChrome
void version
void discovery.list
void finder.findChrome

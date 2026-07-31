import { spawn } from 'node:child_process'
import net from 'node:net'
import process from 'node:process'

const browserPath = process.env.SWM_CDP_BROWSER_PATH

if (!browserPath) {
  throw new Error('SWM_CDP_BROWSER_PATH is required')
}

const browser = spawn(
  browserPath,
  [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9223',
    '--user-data-dir=/tmp/swm-cdp-profile',
    'about:blank'
  ],
  { stdio: 'inherit' }
)
const proxy = net.createServer((downstream) => {
  const upstream = net.connect({ host: '127.0.0.1', port: 9223 })

  downstream.on('error', () => upstream.destroy())
  upstream.on('error', () => downstream.destroy())
  downstream.pipe(upstream)
  upstream.pipe(downstream)
})

proxy.listen(9222, '0.0.0.0')
browser.once('error', shutdown)
browser.once('exit', (code, signal) => {
  proxy.close()
  process.exitCode = code ?? (signal ? 1 : 0)
})
process.once('SIGINT', () => browser.kill('SIGINT'))
process.once('SIGTERM', () => browser.kill('SIGTERM'))

function shutdown(error: Error): void {
  proxy.close()
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
}

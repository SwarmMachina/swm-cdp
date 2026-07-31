export const defaultFlags = Object.freeze([
  '--no-first-run',
  '--disable-default-apps',
  '--no-default-browser-check',
  '--enable-automation',
  '--allow-pre-commit-input',
  '--disable-search-engine-choice-screen',
  '--disable-hang-monitor',
  '--noerrdialogs',
  '--deny-permission-prompts',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-search-geolocation-disclosure',
  '--password-store=basic',
  '--use-mock-keychain',
  '--force-color-profile=srgb',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
  '--disable-ipc-flooding-protection',
  '--disable-background-networking',
  '--disable-domain-reliability',
  '--disable-component-extensions-with-background-pages',
  '--disable-component-update',
  '--disable-updater-scheduler',
  '--disable-sync',
  '--disable-client-side-phishing-detection',
  '--metrics-recording-only',
  '--disable-field-trial-config',
  '--disable-features=Translate,MediaRouter,OptimizationHints'
])

export const headlessFlags = Object.freeze(['--headless', '--hide-scrollbars', '--mute-audio'])

export default defaultFlags

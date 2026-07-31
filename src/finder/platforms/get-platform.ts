import { isWsl } from './wsl.js'

export default function getPlatform(): NodeJS.Platform | 'wsl' {
  return isWsl() ? 'wsl' : process.platform
}

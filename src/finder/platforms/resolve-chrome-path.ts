import canAccess from '../../file-access.js'

export default function resolveChromePath(): string | null {
  const chromePath = process.env.CHROME_PATH

  return chromePath && canAccess(chromePath) ? chromePath : null
}

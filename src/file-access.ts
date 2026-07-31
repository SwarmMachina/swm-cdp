import fs from 'node:fs'

type AccessMode = 'r' | 'rw' | 'w' | 'x'

const accessModes: Readonly<Record<AccessMode, number>> = Object.freeze({
  r: fs.constants.R_OK,
  rw: fs.constants.R_OK | fs.constants.W_OK,
  w: fs.constants.W_OK,
  x: fs.constants.X_OK
})

export default function canAccess(pathName: string, mode: AccessMode = 'x'): boolean {
  if (typeof pathName !== 'string' || pathName.length === 0) {
    return false
  }

  try {
    fs.accessSync(pathName, accessModes[mode] ?? fs.constants.F_OK)

    return true
  } catch {
    return false
  }
}

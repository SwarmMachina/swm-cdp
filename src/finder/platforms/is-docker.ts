import fs from 'node:fs'

function pathExists(path: string): boolean {
  try {
    fs.statSync(path)

    return true
  } catch {
    return false
  }
}

function fileIncludes(path: string, value: string): boolean {
  try {
    return fs.readFileSync(path, 'utf8').includes(value)
  } catch {
    return false
  }
}

export default function isDocker() {
  return pathExists('/.dockerenv') || fileIncludes('/proc/self/cgroup', 'docker')
}

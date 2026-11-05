// Per-user IPC credential. The secret never lives in hook settings or logs.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function getAuthToken(directory = path.join(os.homedir(), '.openmicro')): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const dir = fs.lstatSync(directory)
  const uid = process.getuid?.()
  if (!dir.isDirectory() || (uid !== undefined && dir.uid !== uid) || dir.mode & 0o022)
    throw new Error(
      'OpenMicro credential directory must be owned by you and not writable by others',
    )
  const target = path.join(directory, 'auth-token')
  if (!fs.existsSync(target)) {
    // link publishes a complete credential atomically without replacing a
    // token created concurrently by another wrapper.
    const temporary = path.join(directory, `.auth-${randomBytes(16).toString('hex')}`)
    try {
      fs.writeFileSync(temporary, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
      try {
        fs.linkSync(temporary, target)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    }
  }
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const info = fs.fstatSync(fd)
    if (!info.isFile() || (uid !== undefined && info.uid !== uid) || info.mode & 0o077)
      throw new Error('OpenMicro auth-token must be a private file owned by you (mode 600)')
    const token = fs.readFileSync(fd, 'utf8')
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid OpenMicro auth-token')
    return token
  } finally {
    fs.closeSync(fd)
  }
}

export function hostProof(token: string, challenge: string): string {
  return createHmac('sha256', token).update(`openmicro-host:${challenge}`).digest('hex')
}

export function secretEquals(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAuthToken, hostProof } from '../src/auth.js'
import { isOpenmicroHost, runAsClient } from '../src/client.js'
import { forwardHook } from '../src/hook-forward.js'
import { harnessFor } from '../src/harness/index.js'
import { HostServer } from '../src/server.js'

vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmicro-auth-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('private per-user credential', () => {
  it('creates a stable private credential and leaves no temporary files', () => {
    const token = getAuthToken(dir)
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(getAuthToken(dir)).toBe(token)
    expect(fs.statSync(path.join(dir, 'auth-token')).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(dir)).toEqual(['auth-token'])
  })
  it('refuses readable-by-others credentials without changing the file', () => {
    const target = path.join(dir, 'auth-token')
    fs.writeFileSync(target, 'b'.repeat(64), { mode: 0o644 })
    expect(() => getAuthToken(dir)).toThrow(/private file/)
    expect(fs.readFileSync(target, 'utf8')).toBe('b'.repeat(64))
  })
  it('refuses symlinked credential files', () => {
    fs.writeFileSync(path.join(dir, 'other'), 'c'.repeat(64), { mode: 0o600 })
    fs.symlinkSync(path.join(dir, 'other'), path.join(dir, 'auth-token'))
    expect(() => getAuthToken(dir)).toThrow()
  })
  it('refuses symlinked credential directories', () => {
    const link = path.join(dir, 'link')
    fs.symlinkSync(dir, link)
    expect(() => getAuthToken(link)).toThrow(/directory/)
  })
})

describe('authenticated local communication', () => {
  it('verifies the host and forwards hooks and client keys with the same credential', async () => {
    const token = getAuthToken(dir)
    const server = new HostServer(harnessFor('codex'), 'host', token)
    await server.listen(0)
    const base = `http://127.0.0.1:${server.boundPort}`
    let client: Promise<void> | undefined
    try {
      expect(await isOpenmicroHost(token, base)).toBe(true)
      expect(await isOpenmicroHost('wrong-token', base)).toBe(false)
      vi.stubEnv('OPENMICRO_INSTANCE_ID', 'host')
      await forwardHook(
        'UserPromptSubmit',
        JSON.stringify({ session_id: 'host-session' }),
        token,
        base,
      )
      expect(server.sessionOwners.get('host-session')).toBe('host')

      const write = vi.fn()
      client = runAsClient('client', 'codex', write, token, base)
      vi.stubEnv('OPENMICRO_INSTANCE_ID', 'client')
      await expect
        .poll(async () => {
          await forwardHook(
            'UserPromptSubmit',
            JSON.stringify({ session_id: 'client-session' }),
            token,
            base,
          )
          return server.instanceForSession('client-session')
        })
        .not.toBeNull()
      server.sendKeysToInstance(server.instanceForSession('client-session')!, 'hello 🎮')
      await expect.poll(() => write.mock.calls).toEqual([['hello 🎮']])
    } finally {
      server.close()
      await client
    }
  })

  it('never sends credentials, hooks, or registrations to a server pretending to be OpenMicro', async () => {
    const requests: Array<{ url: string; authorization: string | undefined }> = []
    const fake = http.createServer((req, res) => {
      requests.push({ url: req.url!, authorization: req.headers.authorization })
      res.setHeader('Content-Type', 'application/json')
      // A recorded proof for another nonce must not authenticate this server.
      res.end(JSON.stringify({ app: 'openmicro', proof: hostProof('secret', '0'.repeat(64)) }))
    })
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
    const address = fake.address() as { port: number }
    const base = `http://127.0.0.1:${address.port}`
    try {
      expect(await isOpenmicroHost('secret', base)).toBe(false)
      await expect(runAsClient('client', 'codex-app', vi.fn(), 'secret', base)).rejects.toThrow(
        'Untrusted',
      )
      await forwardHook('Stop', '{"session_id":"private"}', 'secret', base)
      expect(requests).toHaveLength(3)
      expect(
        requests.every((r) => r.url.startsWith('/health?challenge=') && !r.authorization),
      ).toBe(true)
    } finally {
      fake.close()
    }
  })
})

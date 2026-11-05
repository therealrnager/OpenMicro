// Client-instance side of the singleton: when another openmicro already owns
// the port, this instance registers itself and receives forwarded keystrokes
// for its own pty over SSE.

import { randomBytes } from 'node:crypto'
import { hostProof, secretEquals } from './auth.js'
import { logger } from './logger.js'
import { HOST_URL } from './ports.js'

/** True if the process listening on the singleton port is an openmicro host. */
export async function isOpenmicroHost(token: string, baseUrl = HOST_URL): Promise<boolean> {
  try {
    const challenge = randomBytes(32).toString('hex')
    const res = await fetch(`${baseUrl}/health?challenge=${challenge}`, {
      signal: AbortSignal.timeout(1000),
      redirect: 'error',
    })
    if (!res.ok) return false
    const body = (await res.json()) as { app?: string; proof?: string }
    return body.app === 'openmicro' && secretEquals(body.proof, hostProof(token, challenge))
  } catch {
    return false
  }
}

/**
 * Report this wrapper's terminal focus change to the host (fire-and-forget).
 *
 * Args:
 *     wrapperId (string): This instance's OPENMICRO_INSTANCE_ID.
 *     focused (boolean): True on focus-in (ESC[I), false on focus-out (ESC[O).
 *
 * Returns:
 *     None.
 */
export function reportTerminalFocus(wrapperId: string, focused: boolean, token: string): void {
  void isOpenmicroHost(token)
    .then(async (trusted) => {
      if (!trusted) return
      await fetch(`${HOST_URL}/focus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ wrapperId, focused }),
        signal: AbortSignal.timeout(1000),
        redirect: 'error',
      })
    })
    .catch(() => {
      // host gone or not openmicro — focus reports are best-effort
    })
}

/**
 * Register with the host and stream forwarded keystrokes into `write`.
 *
 * Args:
 *     wrapperId (string): This instance's OPENMICRO_INSTANCE_ID, for hook ownership.
 *     kind (string): Harness kind, so the host classifies this session's hooks correctly.
 *     write (function): Sink for decoded keystroke bytes (this instance's pty).
 *
 * Returns:
 *     Promise<void>: Resolves when the host connection closes (host exited).
 */
export async function runAsClient(
  wrapperId: string,
  kind: string,
  write: (bytes: string) => void,
  token: string,
  baseUrl = HOST_URL,
): Promise<void> {
  if (!(await isOpenmicroHost(token, baseUrl))) throw new Error('Untrusted OpenMicro host')
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  const registration = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(1000),
    redirect: 'error',
    body: JSON.stringify({ cwd: process.cwd(), pid: process.pid, wrapperId, kind }),
  })
  if (!registration.ok) throw new Error(`Registration failed: ${registration.status}`)
  const { instanceId } = (await registration.json()) as { instanceId: string }
  if (typeof instanceId !== 'string' || !/^[a-f0-9-]{36}$/.test(instanceId))
    throw new Error('Invalid OpenMicro instance ID')
  logger.info('running as client instance', { instanceId, kind })

  const stream = await fetch(`${baseUrl}/instance/${instanceId}`, { headers, redirect: 'error' })
  if (!stream.ok || !stream.body) throw new Error(`Keystroke stream failed: ${stream.status}`)

  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of stream.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    let sep
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('')
      if (!data) continue
      try {
        const msg = JSON.parse(data) as { type?: string; data?: string }
        if (msg.type === 'keys' && msg.data) {
          write(Buffer.from(msg.data, 'base64').toString('utf8'))
        }
      } catch (err) {
        logger.warn('client: bad frame from host', err)
      }
    }
  }
  logger.info('host connection closed')
}

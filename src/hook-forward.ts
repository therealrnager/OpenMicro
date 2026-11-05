// Hook subprocess: verify the local host before sending any credential or payload.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAuthToken } from './auth.js'
import { isOpenmicroHost } from './client.js'
import { HOST_URL } from './ports.js'

export async function forwardHook(
  event: string,
  body: string,
  token: string,
  baseUrl = HOST_URL,
): Promise<void> {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(event) || Buffer.byteLength(body) > 1_048_576) return
  if (!(await isOpenmicroHost(token, baseUrl))) return
  await fetch(`${baseUrl}/om-hook/${event}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(1000),
    body,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Openmicro-Instance-Id': process.env.OPENMICRO_INSTANCE_ID ?? '',
      'X-Herdr-Pane-Id': process.env.HERDR_PANE_ID ?? '',
    },
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of process.stdin) {
      size += Buffer.byteLength(chunk)
      if (size > 1_048_576) break
      chunks.push(Buffer.from(chunk))
    }
    if (size <= 1_048_576)
      await forwardHook(
        process.argv[2] ?? '',
        Buffer.concat(chunks).toString('utf8'),
        getAuthToken(),
      )
  } catch {
    // A stopped host, missing credential, or broken hook must not interrupt the agent.
  } finally {
    process.stdout.write('{}')
  }
}

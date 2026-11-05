// Host HTTP server on the singleton port. Receives agent lifecycle hook POSTs
// (/om-hook/<event>), classifies them into an AgentState via the harness that
// owns the reporting session, and forwards terminal keystrokes to client
// instances over SSE. No game/sidebar/static serving — openmicro drives a
// controller, not a browser tab.

import { EventEmitter } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { hostProof, secretEquals } from './auth.js'
import http from 'node:http'
import { harnessFor } from './harness/index.js'
import type { Harness } from './harness/types.js'
import { releaseAgent, reportAgentState } from './herdr.js'
import { logger } from './logger.js'
import { HOOK_PATH, HOST_URL } from './ports.js'
import { SessionTracker } from './state.js'

// Every wrapped agent's hooks carry this ownership header (the pty exports
// OPENMICRO_INSTANCE_ID to the agent, and hook commands run with the agent's
// env). Header-less hooks come from sessions openmicro never wrapped — cwd is
// ambiguous when several sessions share a directory, so they are ignored.
const INSTANCE_HEADER = 'x-openmicro-instance-id'

// Herdr pane id, echoed back by hook commands when the wrapped agent runs
// inside a herdr-managed pane (HERDR_PANE_ID in its env). Only honored on
// trusted hooks — same gate as the instance header.
const HERDR_PANE_HEADER = 'x-herdr-pane-id'

// Node's fetch (undici) kills a response body that stays silent for 300s
// (default bodyTimeout), which tore down idle client keystroke streams and
// dropped their sessions from the touchpad cycle. A comment frame every 25s
// keeps the stream alive; SSE clients ignore comment lines by spec.
const HEARTBEAT_MS = 25_000

function sse(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  // retry: a leftover client re-attaches to the new host fast after a restart.
  res.write('retry: 1000\n\n')
}

function send(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

class RequestError extends Error {
  constructor(readonly status: number) {
    super(`Invalid local request (${status})`)
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1_048_576) {
        reject(new RequestError(413))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
    req.on('aborted', () => reject(new RequestError(400)))
  })
}

/**
 * Emits 'aggregate' (Aggregate) whenever hook events (or a background
 * complete→idle decay) may have changed the combined agent state.
 */
export class HostServer extends EventEmitter {
  readonly tracker: SessionTracker
  /** session_id → wrapper id, learned from hook ownership headers. */
  readonly sessionOwners = new Map<string, string>()
  /** session_id → herdr pane id, learned from hook pane headers — lets herdr agent cycling retarget input routing. */
  readonly sessionPanes = new Map<string, string>()
  /** Which harness classifies a wrapper's hooks, resolved from /register. */
  private wrapperHarness = new Map<string, Harness>()

  private server: http.Server | null = null
  private instances = new Map<
    string,
    { res: http.ServerResponse; cwd: string; wrapperId: string | null }
  >()
  private pendingInstances = new Map<string, { cwd: string; wrapperId: string | null }>()

  /**
   * hostHarness classifies the host's own session's hooks (and any hook whose
   * wrapper we never saw a /register for). hostWrapperId scopes which sessions
   * are trusted to drive the FSM: globally-installed hooks fire from every
   * agent session on the machine, and a foreign session stuck 'waiting' would
   * otherwise pin state forever. Unset (tests): no filtering.
   */
  constructor(
    private readonly hostHarness: Harness,
    private readonly hostWrapperId?: string,
    private readonly token: string = randomBytes(32).toString('hex'),
  ) {
    super()
    this.tracker = new SessionTracker({
      onChange: () => this.emit('aggregate', this.tracker.aggregate()),
    })
    if (hostWrapperId) this.wrapperHarness.set(hostWrapperId, hostHarness)
  }

  /** Port actually bound (differs from HOST_PORT only in tests using port 0). */
  boundPort = 0

  /** Bind the singleton port. Resolves true = we are the host, false = port taken. */
  listen(port: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          logger.error('server request failed', err)
          if (!res.headersSent) res.writeHead(err instanceof RequestError ? err.status : 500)
          res.end()
        })
      })
      server.requestTimeout = 5000
      server.headersTimeout = 5000
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') resolve(false)
        else reject(err)
      })
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        const address = server.address()
        this.boundPort = typeof address === 'object' && address ? address.port : port
        resolve(true)
      })
    })
  }

  close(): void {
    for (const { res } of this.instances.values()) res.end()
    this.server?.close()
  }

  /** Write keystrokes to a registered client instance's pty. Returns false if unknown. */
  sendKeysToInstance(instanceId: string, bytes: string): boolean {
    const instance = this.instances.get(instanceId)
    if (!instance) return false
    send(instance.res, { type: 'keys', data: Buffer.from(bytes, 'utf8').toString('base64') })
    return true
  }

  private isActiveOwner(wrapperId: string): boolean {
    if (wrapperId === this.hostWrapperId) return true
    for (const instance of this.instances.values()) {
      if (instance.wrapperId === wrapperId) return true
    }
    return false
  }

  /** Find the client instance that owns the given session (null = host's own pty). */
  instanceForSession(sessionId: string): string | null {
    const owner = this.sessionOwners.get(sessionId)
    if (!owner) return null
    for (const [id, instance] of this.instances) {
      if (instance.wrapperId === owner) return id
    }
    return null
  }

  removeSessionsForOwner(wrapperId: string): boolean {
    let removed = false
    for (const [sessionId, owner] of this.sessionOwners) {
      if (owner !== wrapperId) continue
      removed = this.tracker.remove(sessionId) || removed
      this.sessionOwners.delete(sessionId)
      this.sessionPanes.delete(sessionId)
    }
    return removed
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // This service has no browser UI. Reject cross-origin and DNS-rebinding
    // traffic before it can register clients, inject hooks, or open streams.
    const localHosts = [`127.0.0.1:${this.boundPort}`, `localhost:${this.boundPort}`]
    if (
      !localHosts.includes(req.headers.host ?? '') ||
      req.headers.origin !== undefined ||
      !req.url?.startsWith('/') ||
      req.url.startsWith('//')
    ) {
      res.writeHead(403)
      res.end()
      return
    }
    const url = new URL(req.url, HOST_URL)
    const { pathname } = url

    if (req.method === 'GET' && pathname === '/health') {
      const challenge = url.searchParams.get('challenge')
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(
        JSON.stringify({
          app: 'openmicro',
          ...(challenge && /^[a-f0-9]{64}$/.test(challenge)
            ? { proof: hostProof(this.token, challenge) }
            : {}),
        }),
      )
      return
    }
    if (!secretEquals(req.headers.authorization, `Bearer ${this.token}`)) {
      res.writeHead(401)
      res.end()
      return
    }

    if (req.method === 'POST' && pathname.startsWith(HOOK_PATH)) {
      await this.handleHook(pathname.slice(HOOK_PATH.length), req, res)
      return
    }

    if (req.method === 'POST' && pathname === '/register') {
      await this.handleRegister(req, res)
      return
    }

    // Terminal window/pane focus changes, observed by each wrapper's pty from
    // mode-1004 focus reporting. The host uses focus-out to disengage voice.
    if (req.method === 'POST' && pathname === '/focus') {
      const body = await readBody(req)
      try {
        const { wrapperId, focused } = JSON.parse(body) as { wrapperId: string; focused: boolean }
        if (typeof wrapperId === 'string' && typeof focused === 'boolean')
          this.emit('terminal-focus', { wrapperId, focused })
      } catch {
        // malformed focus report — ignore
      }
      res.writeHead(200)
      res.end()
      return
    }

    if (req.method === 'GET' && pathname.startsWith('/instance/')) {
      this.handleInstanceStream(pathname.slice('/instance/'.length), req, res)
      return
    }

    res.writeHead(404)
    res.end()
  }

  private async handleHook(
    event: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readBody(req)
    let sessionId = 'unknown'
    let payload: unknown
    try {
      payload = JSON.parse(body)
      sessionId = (payload as { session_id?: string }).session_id ?? 'unknown'
    } catch {
      // Payload shape is the harness's internal contract — event name alone still works.
    }

    const header = req.headers[INSTANCE_HEADER]
    let wrapperId = Array.isArray(header) ? header[0] : header
    // GUI host fallback: a usesPty:false host drives a desktop app that has no
    // OPENMICRO_INSTANCE_ID env, so its hooks arrive with an empty/missing
    // header — attribute them to the host wrapper so state reaches the
    // tracker. usesPty defaults true, so this is a no-op for CLI harnesses.
    // Claude-origin hooks also arrive header-less (any unwrapped Claude Code
    // session posts here); their transcript_path lives under ~/.claude — skip
    // them, or foreign sessions become phantom "agents" that steal focus.
    const claudeOrigin =
      typeof (payload as { transcript_path?: unknown })?.transcript_path === 'string' &&
      ((payload as { transcript_path: string }).transcript_path.includes('/.claude/') ||
        (payload as { transcript_path: string }).transcript_path.includes('/.config/claude/'))
    if (!wrapperId && !claudeOrigin && this.hostWrapperId && this.hostHarness.usesPty === false)
      wrapperId = this.hostWrapperId

    // Only sessions owned by an active wrapper (the host's own agent or a
    // registered client) drive the FSM. Header-less hooks come from agent
    // sessions openmicro never wrapped; when scoping is on they are ignored —
    // cwd cannot disambiguate sessions sharing a directory.
    let trusted: boolean
    let harness: Harness = this.hostHarness
    if (wrapperId) {
      trusted = this.isActiveOwner(wrapperId)
      harness = this.wrapperHarness.get(wrapperId) ?? this.hostHarness
      if (trusted) this.sessionOwners.set(sessionId, wrapperId)
    } else {
      trusted = !this.hostWrapperId // filtering off (bare server in tests)
    }

    const paneHeader = req.headers[HERDR_PANE_HEADER]
    const herdrPaneId = Array.isArray(paneHeader) ? paneHeader[0] : paneHeader

    if (trusted) {
      // Ground truth that dictation ended without a controller press: tap-mode
      // auto-submit fires this hook the instant the transcript is sent. The
      // host uses it to drop stale voice tracking (a stale Space toggle sent
      // into the now-empty prompt would START a new recording).
      if (event === 'UserPromptSubmit')
        this.emit('prompt-submit', { sessionId, hostOwned: wrapperId === this.hostWrapperId })
      let changed = false
      if (event === 'SessionEnd') {
        // Harnesses classify SessionEnd as null (caller removes) — a dead waiter
        // must not pin the FSM.
        changed = this.tracker.remove(sessionId)
        this.sessionPanes.delete(sessionId)
        this.sessionOwners.delete(sessionId)
        if (herdrPaneId) releaseAgent(herdrPaneId)
      } else {
        const state = harness.stateForHookEvent(event, payload)
        if (state !== null) {
          changed = this.tracker.apply(sessionId, state, { focusOnStop: Boolean(wrapperId) })
          if (herdrPaneId) {
            this.sessionPanes.set(sessionId, herdrPaneId)
            reportAgentState(herdrPaneId, state, sessionId)
          }
        }
      }
      if (changed) this.emit('aggregate', this.tracker.aggregate())
    }
    res.writeHead(200)
    res.end()
  }

  private async handleRegister(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req)
    let cwd = ''
    let wrapperId: string | null = null
    let kind: string | undefined
    try {
      const registration = JSON.parse(body) as { cwd?: string; wrapperId?: string; kind?: string }
      cwd = registration.cwd ?? ''
      wrapperId = registration.wrapperId ?? null
      kind = registration.kind
    } catch {
      // cwd stays unmatched; keystrokes just won't route to this instance.
    }
    let harness = this.hostHarness
    if (kind) {
      try {
        harness = harnessFor(kind)
      } catch {
        // Unknown kind from a client — classify with the host harness as a fallback.
      }
    }
    if (wrapperId) this.wrapperHarness.set(wrapperId, harness)
    const id = randomUUID()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ instanceId: id, cwd, wrapperId }))
    logger.info('client instance registered', { id, cwd, wrapperId, kind })
    // The SSE connection on /instance/<id> completes registration.
    this.pendingInstances.set(id, { cwd, wrapperId })
  }

  private handleInstanceStream(
    id: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    if (this.instances.has(id)) {
      res.writeHead(409)
      res.end()
      return
    }
    const pending = this.pendingInstances.get(id)
    if (!pending) {
      res.writeHead(404)
      res.end()
      return
    }
    sse(res)
    this.instances.set(id, { res, ...pending })
    this.pendingInstances.delete(id)
    const heartbeat = setInterval(() => res.write(': hb\n\n'), HEARTBEAT_MS)
    heartbeat.unref?.()
    req.on('close', () => {
      clearInterval(heartbeat)
      const instance = this.instances.get(id)
      if (!instance || instance.res !== res) return
      this.instances.delete(id)
      if (instance.wrapperId && this.removeSessionsForOwner(instance.wrapperId)) {
        this.emit('aggregate', this.tracker.aggregate())
      }
    })
  }
}

// Exercise real CLI routing with only external side effects mocked.
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ButtonId, ControllerEvent } from '../src/types.js'

const io = vi.hoisted(() => ({
  execute: vi.fn(),
  dispose: vi.fn(),
  pad: null as EventEmitter | null,
}))
vi.mock('node:child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn() }))
vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../src/auth.js', () => ({ getAuthToken: () => 'test-token' }))
vi.mock('../src/pty.js', () => ({ AgentPty: vi.fn() }))
vi.mock('../src/invocation.js', () => ({
  parseInvocation: () => ({ kind: 'codex-app', agentArgs: [] }),
  USAGE: '',
}))
vi.mock('../src/controller/hid-manager.js', () => ({
  HidManager: class extends EventEmitter {
    constructor() {
      super()
      io.pad = this
    }
    start() {}
    stop() {}
  },
}))
vi.mock('../src/layers.js', async (original) => {
  const actual = await original<typeof import('../src/layers.js')>()
  return { ...actual, loadConfig: () => structuredClone(actual.DEFAULT_CONFIG) }
})
vi.mock('../src/harness/index.js', async () => {
  const { codexAppHarness } = await import('../src/harness/codex-app.js')
  return {
    harnessFor: () => ({
      ...codexAppHarness,
      installHooks: () => ({ changed: false, trustNotice: null }),
      execute: io.execute,
      dispose: io.dispose,
    }),
  }
})
vi.mock('../src/server.js', () => ({
  HostServer: class extends EventEmitter {
    tracker = { list: () => [], aggregate: () => ({ focusSessionId: null }) }
    sessionPanes = new Map()
    sessionOwners = new Map()
    async listen() {
      return true
    }
    close() {}
    instanceForSession() {
      return null
    }
  },
}))

let handlers: Record<string, Set<NodeJS.SignalsListener>>
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.stubEnv('HERDR_PANE_ID', '')
  handlers = Object.fromEntries(
    (['SIGINT', 'SIGTERM'] as const).map((s) => [s, new Set(process.listeners(s))]),
  )
  await import('../src/cli.js')
})
afterEach(() => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const listener of process.listeners(signal)) {
      if (!handlers[signal]!.has(listener)) process.removeListener(signal, listener)
    }
  }
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
const send = (event: ControllerEvent) => io.pad!.emit('data', event)
const button = (id: ButtonId, pressed = true) => send({ kind: 'button', button: id, pressed })

describe('CLI held input cleanup', () => {
  it('stops repeating navigation when a layer switch swallows the release', () => {
    button('dpad_right')
    button('l1')
    button('east')
    button('dpad_right', false)
    vi.advanceTimersByTime(1500)
    expect(io.execute).toHaveBeenCalledTimes(1)
  })
  it('releases dictation keys when the controller disconnects', () => {
    button('north')
    send({ kind: 'disconnected' })
    expect(io.execute).toHaveBeenLastCalledWith(
      'osascript:key up "d"\nkey up shift\nkey up control',
    )
  })
  it('releases dictation keys when changing layers', () => {
    button('north')
    button('l1')
    button('east')
    button('north', false)
    expect(io.execute).toHaveBeenLastCalledWith(
      'osascript:key up "d"\nkey up shift\nkey up control',
    )
  })
  it('forgets a held layer modifier on reconnect', () => {
    button('l1')
    send({ kind: 'disconnected' })
    send({ kind: 'connected', controllerType: 'ds4' })
    button('south')
    expect(io.execute).toHaveBeenLastCalledWith('osascript:keystroke return')
  })
})

// Preserve foreign hooks, migrate our old curl hooks, and install the authenticated forwarder.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { logger } from './logger.js'
import { HOOK_URL } from './ports.js'

type Settings = Record<string, unknown> & { hooks?: Record<string, unknown[]> }
export type HookWriteResult = 'changed' | 'unchanged' | 'failed'
const MARKER = '# openmicro:hook-forward'
const LEGACY_MARKER = new URL(HOOK_URL).host + new URL(HOOK_URL).pathname

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function command(event: string): string {
  const helper = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts') ? '../dist/hook-forward.js' : './hook-forward.js',
      import.meta.url,
    ),
  )
  return `${shellQuote(process.execPath)} ${shellQuote(helper)} ${shellQuote(event)} 2>/dev/null || printf '{}' ${MARKER}`
}

function owned(hook: unknown): boolean {
  return (
    object(hook) &&
    typeof hook.command === 'string' &&
    (hook.command.includes(MARKER) ||
      hook.command.includes(LEGACY_MARKER) ||
      hook.command.includes('X-Openmicro-Instance-Id'))
  )
}

function foreignGroups(groups: unknown[]): unknown[] {
  return groups.flatMap((group) => {
    if (!object(group) || !Array.isArray(group.hooks)) return [group]
    const hooks = group.hooks.filter((hook) => !owned(hook))
    if (hooks.length === group.hooks.length) return [group]
    return hooks.length ? [{ ...group, hooks }] : []
  })
}

function install(
  target: string,
  events: Record<string, string | undefined>,
  purgeAll: boolean,
): HookWriteResult {
  let settings: Settings = {}
  const temporary = `${target}.${randomUUID()}.openmicro-tmp`
  try {
    try {
      if (fs.lstatSync(target).isSymbolicLink())
        throw new Error('Refusing to replace a symlinked hook file')
      const parsed: unknown = JSON.parse(fs.readFileSync(target, 'utf8'))
      if (
        !object(parsed) ||
        (parsed.hooks !== undefined &&
          (!object(parsed.hooks) ||
            Object.values(parsed.hooks).some((groups) => !Array.isArray(groups))))
      )
        throw new Error('Invalid hook settings structure; leaving the file untouched')
      settings = parsed as Settings
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const before = JSON.stringify(settings)
    settings.hooks ??= {}
    if (purgeAll) {
      for (const [event, groups] of Object.entries(settings.hooks)) {
        const remaining = foreignGroups(groups)
        if (remaining.length || groups.length === 0) settings.hooks[event] = remaining
        else delete settings.hooks[event]
      }
    }
    for (const [event, matcher] of Object.entries(events)) {
      settings.hooks[event] = [
        ...foreignGroups(settings.hooks[event] ?? []),
        {
          ...(matcher !== undefined ? { matcher } : {}),
          hooks: [{ type: 'command', command: command(event) }],
        },
      ]
    }
    if (JSON.stringify(settings) === before) return 'unchanged'
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    })
    fs.renameSync(temporary, target)
    return 'changed'
  } catch (err) {
    logger.warn('hooks-install: leaving existing settings untouched', err)
    return 'failed'
  } finally {
    try {
      fs.unlinkSync(temporary)
    } catch {
      /* No temporary file to clean up. */
    }
  }
}

export function installClaudeHooks(settingsPath?: string): HookWriteResult {
  return install(
    settingsPath ?? path.join(os.homedir(), '.claude', 'settings.json'),
    {
      SessionStart: undefined,
      UserPromptSubmit: undefined,
      Stop: undefined,
      Notification: undefined,
      PreToolUse: 'AskUserQuestion',
      PostToolUse: undefined,
      SessionEnd: undefined,
    },
    false,
  )
}

export function installCodexHooks(hooksPath?: string): HookWriteResult {
  return install(
    hooksPath ??
      path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'hooks.json'),
    {
      UserPromptSubmit: undefined,
      PermissionRequest: undefined,
      PostToolUse: undefined,
      Stop: undefined,
    },
    true,
  )
}

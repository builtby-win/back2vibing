import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
// @ts-expect-error OpenCode provides this package in the hook runtime.
import type { Plugin } from '@opencode-ai/plugin'

const execFileAsync = promisify(execFile)

const DEFAULT_TMUX_COMMAND_TIMEOUT_MS = 2000

const getTmuxCommandTimeoutMs = () => {
  const parsed = Number.parseInt(process.env.B2V_TMUX_COMMAND_TIMEOUT_MS || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TMUX_COMMAND_TIMEOUT_MS
}

const withDeadline = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

const tmuxExecEnv = () => {
  const currentPath = process.env.PATH || ''
  const extraPaths = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]
  return {
    ...process.env,
    PATH: `${currentPath}:${extraPaths.join(':')}`,
  }
}

const execTmuxDisplayMessage = async (args: string[]) => {
  const timeoutMs = getTmuxCommandTimeoutMs()
  const result = await withDeadline(
    execFileAsync('tmux', args, {
      env: tmuxExecEnv(),
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    }),
    timeoutMs,
    `tmux ${args.join(' ')}`,
  )
  return result.stdout.trim()
}

/**
 * Checks if a process with the exact name is currently running.
 * Used to verify the dev app is active before attempting activation via AppleScript.
 */
const isProcessRunning = async (name: string): Promise<boolean> => {
  try {
    // -x matches the process name exactly.
    await execFileAsync('pgrep', ['-x', name])
    return true
  } catch {
    return false
  }
}

const DEFAULT_LOG_DIR = '/tmp/back2vibing'
const resolveLogDir = () => {
  const configuredLogDir = process.env.B2V_LOG_DIR?.trim()
  if (configuredLogDir && path.isAbsolute(configuredLogDir)) return configuredLogDir
  return DEFAULT_LOG_DIR
}

const AGENT_ID = 'opencode'
const DEBUG_EVENTS = process.env.B2V_EVENT_DEBUG === 'true' || process.env.B2V_EVENT_DEBUG === '1'
let TEST_SCOPED_IPC_SOCKET_PATH_OVERRIDE: string | null = null

const isB2vDisabled = () => process.env.B2V_DISABLED === 'true' || process.env.B2V_DISABLED === '1'

const getScopedIpcSocketPath = () =>
  TEST_SCOPED_IPC_SOCKET_PATH_OVERRIDE ||
  process.env.B2V_SCOPED_IPC_SOCKET_PATH ||
  '__B2V_IPC_SOCKET_PATH__'

// Test-only hooks. MUST NOT be exposed as named exports — the OpenCode plugin
// runtime walks named exports as plugin factories, so exporting these would
// crash plugin loading (see comment further down near the socket helpers).
// Tests reach these via `globalThis.__B2V_HOOKS_TEST__` after importing the
// module under VITEST.
const __testHandle = {
  setScopedIpcSocketPath: (value: string | null) => {
    TEST_SCOPED_IPC_SOCKET_PATH_OVERRIDE = value
  },
  shouldSkipSubagentHooks: (
    eventType: string,
    event: Record<string, unknown>,
    sessionId?: string,
  ) => shouldSkipSubagentHooks(eventType, event, sessionId),
  resetHooksState: () => {
    recentFocusEventByKey.clear()
    inFlightFocusEvents.clear()
    recentIdleRequestBySession.clear()
    directBusyStatusBySession.clear()
    activePromptIntercepts.clear()
    inFlightPromptRequests.clear()
    subagentSessionIds.clear()
    registeredSessionHashes.clear()
    firstEventHandled = false
    sdkPromptClientPromise = null
    promptClientPromise = null
    cachedDefaultApp = null
  },
  getTmuxInfo: () => getTmuxInfo(),
  spawnPromptAgentEvent: (
    cliPath: string,
    args: string[],
    event: Record<string, unknown>,
    socketPath: string | null,
  ) => spawnPromptAgentEvent(cliPath, args, event, socketPath),
}

if (process.env.VITEST) {
  ;(globalThis as Record<string, unknown>).__B2V_HOOKS_TEST__ = __testHandle
}

type PromptRequestIdentifiers = {
  id: string
  requestID: string
  request_id: string
  requestId: string
}

type PermissionReplyClient = {
  permission?: {
    reply?: (
      args: PromptRequestIdentifiers & {
        reply: 'once' | 'always' | 'reject'
        directory: string
      },
    ) => Promise<unknown>
  }
  question?: {
    reply?: (
      args: PromptRequestIdentifiers & {
        answers: string[][]
        directory: string
      },
    ) => Promise<unknown>
    reject?: (args: PromptRequestIdentifiers & { directory: string }) => Promise<unknown>
  }
}

type PromptClientCapabilities = {
  permissionReply: boolean
  questionReply: boolean
  questionReject: boolean
}

type PromptClientResourceSummary = {
  own_keys: string[]
  proto_keys: string[]
  reply_type?: string
  reject_type?: string
  access_error?: string
}

type OpencodeSdkModule = {
  createOpencodeClient?: (config?: { baseUrl?: string; directory?: string }) => unknown
  OpencodeClient?: new (args?: { client?: unknown }) => unknown
}

type AgentEventPermissionResult = {
  kind: 'permission'
  request_id: string
  reply: 'once' | 'always' | 'reject'
}

type AgentEventQuestionResult = {
  kind: 'question'
  request_id: string
  answers?: string[][]
  rejected?: true
}

type AgentEventNativePromptPassThroughResult = {
  kind: 'native_prompt_pass_through'
  request_id?: string
}

type AgentEventPromptResult =
  | AgentEventPermissionResult
  | AgentEventQuestionResult
  | AgentEventNativePromptPassThroughResult

type PromptInterceptTrace = {
  intercept_id: string
  event_type: string
  request_id: string
  session_id: string
  target: string
  started_at_ms: number
}

type PromptExecTrace = {
  exec_id: string
  intercept_id?: string
  request_id?: string
}

let promptInterceptSeq = 0
let promptExecSeq = 0
const activePromptIntercepts = new Map<string, PromptInterceptTrace>()

const nextPromptInterceptId = () => {
  promptInterceptSeq += 1
  return `pi_${promptInterceptSeq}`
}

const nextPromptExecId = () => {
  promptExecSeq += 1
  return `pe_${promptExecSeq}`
}

const logLine = async (message: string) => {
  if (!DEBUG_EVENTS && !process.env.VITEST) return

  if (process.env.VITEST) {
    console.error(`[HOOK-LOG] ${message}`)
  }
  const logDir = resolveLogDir()
  const logFile = path.join(logDir, 'back2vibing.log')
  await fs.mkdir(logDir, { recursive: true })
  await fs.chmod(logDir, 0o700).catch(() => {
    // Best-effort
  })
  const timestamp = new Date().toISOString().replace('T', ' ').replace('Z', '')
  await fs.appendFile(logFile, `[${timestamp}][PID:${process.pid}][TS-HOOKS] ${message}\n`, {
    mode: 0o600,
  })
  await fs.chmod(logFile, 0o600).catch(() => {
    // Best-effort hardening; logging must not break hook execution.
  })
}

const logBlock = async (header: string, payload: unknown) => {
  if (!DEBUG_EVENTS && !process.env.VITEST) return

  await logLine(header)
  const pretty = JSON.stringify(payload, null, 2)
  const lines = pretty.split('\n')
  for (const line of lines) {
    await logLine(`  ${line}`)
  }
}

const summarizeEvent = (event: Record<string, unknown>, directory?: string) => {
  const summary: Record<string, unknown> = {
    type: event.type,
    session_id: extractSessionId(event) || undefined,
    cwd: extractCwd(event, directory) || undefined,
  }

  const properties = asRecord(event.properties)
  const session = asRecord(event.session)

  if (properties) {
    const info = asRecord(properties.info)
    summary.properties = {
      kind: properties.kind,
      op: properties.op,
      name: properties.name,
      id: info?.id ?? properties.id,
    }
  }

  if (session) {
    summary.session = {
      id: session.id ?? session.session_id,
      hash: session.hash,
      status: session.status,
    }
  }

  const notificationType = pickString(
    event.notification_type,
    event.notificationType,
    properties?.notification_type,
    properties?.notificationType,
  )
  if (notificationType) {
    summary.notification_type = notificationType
  }

  const message = pickString(event.message, properties?.message)
  if (message) {
    summary.message = message
  }

  return summary
}

const getHomeDir = () => process.env.HOME || os.homedir()

const getConfigDir = () => {
  if (process.env.VITEST) {
    return path.join(getHomeDir(), '.config/back2vibing')
  }

  if (process.platform === 'darwin') {
    return path.join(getHomeDir(), 'Library/Application Support/back2vibing')
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(getHomeDir(), 'AppData/Roaming')
    return path.join(appData, 'back2vibing')
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(getHomeDir(), '.config')
  return path.join(xdgConfig, 'back2vibing')
}

const getEnvSocketCandidates = () => {
  return [process.env.BACK2V_IPC_SOCKET, process.env.B2V_IPC_SOCKET]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim())
    .filter(Boolean)
}

const getScopedSocketCandidates = () => {
  const scopedSocketPath = getScopedIpcSocketPath().trim()
  if (!scopedSocketPath || scopedSocketPath.startsWith('__B2V_')) return []
  return [scopedSocketPath]
}

const getDirectoryCliCandidates = (directory?: string) => {
  if (!directory) return []

  const trimmed = directory.trim()
  if (!trimmed) return []

  return [path.join(trimmed, 'target/debug/b2v')]
}

const getBundledCliCandidates = () => {
  const execPath = pickString(process.execPath)
  if (!execPath) return []

  const execDir = path.dirname(execPath)
  return [path.join(execDir, 'b2v')]
}

const SOCKET_ENV_PATTERN = /\$(\w+)|\$\{([^}]+)\}/g

const logDebugLine = async (message: string) => {
  if (!DEBUG_EVENTS) return
  await logLine(`[debug] ${message}`)
}

const summarizeProcessError = (error: unknown) => {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      code?: number | string
      message?: string
      stderr?: string
      stdout?: string
      signal?: string
    }
    const details = [
      candidate.message,
      candidate.code !== undefined ? `code=${candidate.code}` : null,
      candidate.signal ? `signal=${candidate.signal}` : null,
    ].filter(Boolean)

    const extras = [
      candidate.stdout ? `stdout=${candidate.stdout.toString().trim().slice(0, 200)}` : null,
      candidate.stderr ? `stderr=${candidate.stderr.toString().trim().slice(0, 200)}` : null,
    ].filter(Boolean)

    if (details.length || extras.length) {
      return [...details, ...extras].join(' ')
    }
  }

  return String(error)
}

// NOTE: Keep socket helpers module-private.
// The OpenCode plugin runtime may treat named exports as hook entrypoints,
// so exporting test helpers from this file can break plugin execution.
const resolveSocketPath = (rawPath: unknown) => {
  if (typeof rawPath !== 'string') return ''

  const trimmed = rawPath.trim()
  if (!trimmed) return ''

  const homeExpanded =
    trimmed === '~'
      ? getHomeDir()
      : trimmed.startsWith('~/')
        ? path.join(getHomeDir(), trimmed.slice(2))
        : trimmed

  return homeExpanded.replace(
    SOCKET_ENV_PATTERN,
    (fullMatch, bareVariableName: string | undefined, bracedVariableName: string | undefined) => {
      const variableName = bareVariableName || bracedVariableName
      if (!variableName) return fullMatch

      const resolved = process.env[variableName]
      return resolved === undefined ? fullMatch : resolved
    },
  )
}

const isUnixSocketPath = async (socketPath: string) => {
  try {
    const stat = await fs.stat(socketPath)
    const isSocket = stat.isSocket()
    if (process.env.VITEST) {
      await logLine(`Vitest: isUnixSocketPath(${socketPath}) -> ${isSocket}`)
    }
    return isSocket
  } catch (error) {
    if (process.env.VITEST) {
      await logLine(`Vitest: isUnixSocketPath(${socketPath}) failed: ${String(error)}`)
    }
    return false
  }
}

type SocketCandidate = {
  rawPath: string
  source: string
}

const getDefaultSocketPath = () => path.join(getConfigDir(), 'back2vibing.sock')

const canReachSocketPath = async (socketPath: string, timeoutMs = 1000) => {
  return new Promise<boolean>((resolve) => {
    let settled = false

    const settle = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(value)
    }

    const socket = net.createConnection(socketPath)
    const timeout = setTimeout(() => {
      void logDebugLine(`Socket reachability timed out: ${socketPath}`)
      socket.destroy()
      settle(false)
    }, timeoutMs)

    socket.on('connect', () => {
      socket.end()
      settle(true)
    })

    socket.on('error', (error) => {
      void logDebugLine(`Socket reachability failed for ${socketPath}: ${String(error)}`)
      settle(false)
    })

    socket.on('close', () => {
      if (!settled) {
        settle(false)
      }
    })
  })
}

const resolveReachableSocketPath = async (candidate: SocketCandidate) => {
  const resolvedSocketPath = resolveSocketPath(candidate.rawPath)
  if (!resolvedSocketPath) {
    await logDebugLine(`Socket path from ${candidate.source} is empty after expansion`)
    return null
  }

  if (!path.isAbsolute(resolvedSocketPath)) {
    await logLine(
      `Socket path from ${candidate.source} is not absolute after expansion: ${candidate.rawPath} -> ${resolvedSocketPath}`,
    )
    return null
  }

  const isSocket = await isUnixSocketPath(resolvedSocketPath)
  if (process.env.VITEST) {
    console.error(`[HOOK-LOG] isUnixSocketPath(${resolvedSocketPath}) -> ${isSocket}`)
  }
  if (!isSocket) {
    await logDebugLine(
      `Socket path from ${candidate.source} is missing/invalid: ${candidate.rawPath} -> ${resolvedSocketPath}`,
    )
    return null
  }

  const reachable = await canReachSocketPath(resolvedSocketPath)
  if (process.env.VITEST) {
    console.error(`[HOOK-LOG] canReachSocketPath(${resolvedSocketPath}) -> ${reachable}`)
  }

  if (reachable) {
    await logDebugLine(`Socket path selected from ${candidate.source}: ${resolvedSocketPath}`)
    return resolvedSocketPath
  }

  await logLine(`Socket path from ${candidate.source} is not reachable: ${resolvedSocketPath}`)
  return null
}

const getSocketPath = async () => {
  const candidates: SocketCandidate[] = getEnvSocketCandidates().map((rawPath) => ({
    source: 'env var',
    rawPath,
  }))

  if (candidates.length > 0) {
    for (const candidate of candidates) {
      const reachable = await resolveReachableSocketPath(candidate)
      if (reachable) return reachable
    }
    await logLine(
      'Explicit IPC socket env was set, but no env socket was reachable; trying discovered sockets',
    )
  }

  for (const rawPath of getScopedSocketCandidates()) {
    candidates.push({ source: 'scoped hook socket', rawPath })
  }

  const socketFile = path.join(getConfigDir(), 'socket.path')
  try {
    const contents = await fs.readFile(socketFile, 'utf8')
    candidates.push({ source: socketFile, rawPath: contents })
  } catch (error) {
    await logDebugLine(`Unable to read socket path file ${socketFile}: ${String(error)}`)
  }

  candidates.push({ source: 'default production socket', rawPath: getDefaultSocketPath() })

  const seen = new Set<string>()
  for (const candidate of candidates) {
    const resolved = resolveSocketPath(candidate.rawPath)
    if (resolved && seen.has(resolved)) continue
    if (resolved) seen.add(resolved)

    const reachable = await resolveReachableSocketPath(candidate)
    if (reachable) return reachable
  }

  return null
}

const PROD_FALLBACK_APP = 'back2vibing'
const DEV_FALLBACK_APP = 'back2vibing Dev'

const sanitizeFallbackSound = (sound: string) => {
  const trimmed = sound.trim()
  if (!trimmed) return ''
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : ''
}

const resolveBack2VibingFallbackApp = async (fallbackApp: string) => {
  if (fallbackApp !== PROD_FALLBACK_APP) return fallbackApp
  if (await isProcessRunning(DEV_FALLBACK_APP)) {
    await logLine(`Local fallback: using running dev app '${DEV_FALLBACK_APP}'`)
    return DEV_FALLBACK_APP
  }
  return fallbackApp
}

// Returns the app name to activate as a local fallback. If the saved/default
// fallback targets production back2vibing while the dev app is running, prefer
// the dev app so local testing doesn't open an older installed build.
const resolveFallbackApp = async (): Promise<string | null> => {
  const envApp = process.env.B2V_FALLBACK_APP?.trim()
  if (envApp) return envApp
  if (cachedDefaultApp) {
    await logLine(`Local fallback: using cached default app '${cachedDefaultApp}'`)
    return resolveBack2VibingFallbackApp(cachedDefaultApp)
  }
  return resolveBack2VibingFallbackApp(PROD_FALLBACK_APP)
}

const resolveFallbackSound = () => {
  const envSound = process.env.B2V_FALLBACK_SOUND?.trim()
  if (envSound) return sanitizeFallbackSound(envSound)
  return 'Bottle'
}

const runLocalFallback = async (soundMuted: boolean) => {
  // Skip activation only for explicit test mode to avoid system dialogs and accidental app launches.
  if (process.env.B2V_TEST_MODE) {
    await logLine('Local fallback activation skipped: test environment detected.')
    return false
  }

  const fallbackApp = await resolveFallbackApp()
  const fallbackSound = resolveFallbackSound()

  let activationSucceeded = false
  let soundQueued = false

  if (fallbackApp) {
    // Safety guard for our own apps: if the app isn't running, skip
    // AppleScript activation (avoids the "Where is back2vibing Dev?" dialog
    // for stale dev sockets, and prevents launching a closed production app).
    // IMPORTANT: This must NOT return early — sound playback below is
    // independent of activation so both "sound only" and "sound + activate"
    // paths work correctly.
    const appIsRunning =
      !fallbackApp.startsWith('back2vibing') || (await isProcessRunning(fallbackApp))

    if (appIsRunning) {
      await logLine(`Local fallback: activating app '${fallbackApp}'`)
      try {
        const lowerApp = fallbackApp.toLowerCase()
        if (lowerApp === 'iterm' || lowerApp === 'iterm2') {
          await execFileAsync('osascript', [
            '-e',
            'tell application id "com.googlecode.iterm2" to activate',
          ])
        } else if (lowerApp === 'terminal') {
          await execFileAsync('osascript', [
            '-e',
            'tell application id "com.apple.Terminal" to activate',
          ])
        } else {
          await execFileAsync('osascript', [
            '-e',
            'on run argv',
            '-e',
            'tell application (item 1 of argv) to activate',
            '-e',
            'end run',
            fallbackApp,
          ])
        }
        activationSucceeded = true
      } catch (error) {
        await logLine(`Local fallback primary activation failed: ${String(error)}`)
        try {
          await execFileAsync('open', ['-a', fallbackApp])
          activationSucceeded = true
        } catch (openError) {
          await logLine(`Local fallback app activation failed: ${String(openError)}`)
        }
      }
    } else {
      await logLine(
        `Local fallback: app '${fallbackApp}' is not running; skipping activation. Sound may still play.`,
      )
    }
  } else {
    await logLine(
      'Local fallback: no default app configured. Open back2vibing → Settings → Focus → set a Default App to enable terminal activation when IPC is unavailable.',
    )
  }

  if (fallbackSound && !soundMuted) {
    const soundPath = `/System/Library/Sounds/${fallbackSound}.aiff`
    // Ignore errors from afplay (sound playback is optional)
    void execFileAsync('afplay', [soundPath]).catch(() => {
      // Ignore sound errors
    })
    soundQueued = true
  }

  return activationSucceeded || soundQueued
}

// =============================================================================
// b2v CLI Transport
// =============================================================================

type CliHelpCacheEntry = {
  help: string | null
  mtimeMs: number
  size: number
}

const cliHelpCache = new Map<string, CliHelpCacheEntry>()

const getCliBinaryFingerprint = async (
  cliPath: string,
): Promise<Pick<CliHelpCacheEntry, 'mtimeMs' | 'size'> | null> => {
  try {
    const stat = await fs.stat(cliPath)
    return {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    }
  } catch {
    return null
  }
}

const readB2vCliHelp = async (cliPath: string) => {
  const fingerprint = await getCliBinaryFingerprint(cliPath)
  const cached = cliHelpCache.get(cliPath)
  if (
    cached &&
    fingerprint &&
    cached.mtimeMs === fingerprint.mtimeMs &&
    cached.size === fingerprint.size
  ) {
    return cached.help
  }

  if (cached) {
    cliHelpCache.delete(cliPath)
  }

  try {
    const { stdout } = await execFileAsync(cliPath, ['--help'], {
      timeout: 3000,
    })
    if (fingerprint) {
      cliHelpCache.set(cliPath, {
        help: stdout,
        mtimeMs: fingerprint.mtimeMs,
        size: fingerprint.size,
      })
    }
    return stdout
  } catch (error) {
    await logLine(`b2v CLI help check failed: ${cliPath}: ${summarizeProcessError(error)}`)
    if (fingerprint) {
      cliHelpCache.set(cliPath, {
        help: null,
        mtimeMs: fingerprint.mtimeMs,
        size: fingerprint.size,
      })
    }
    return null
  }
}

const b2vCliSupportsCommand = async (cliPath: string, command: string) => {
  // Primary check: parse --help output (cached per binary fingerprint)
  const help = await readB2vCliHelp(cliPath)
  if (help) {
    const inHelp = new RegExp(`^\\s+${command}(\\s|$)`, 'm').test(help)
    if (inHelp) return true
  }

  // Fallback: try --supports probe for CLIs where the command exists
  // but isn't listed in --help. The CLI prints "supported" to stdout.
  try {
    const { stdout } = await execFileAsync(cliPath, ['--supports', command], {
      timeout: 500,
    })
    if (stdout.trim() === 'supported') {
      return true
    }
  } catch {
    // Timeout, exit code 1, or old CLI without --supports — fall through
  }

  if (!help) {
    await logLine(`b2v CLI help unavailable: ${cliPath}`)
  } else {
    await logLine(`b2v CLI missing ${command} command: ${cliPath}`)
  }
  return false
}

const resolveB2vCli = async (
  directory?: string,
  requiredCommand?: 'agent-event' | 'ipc-call',
): Promise<string | null> => {
  const candidates: Array<{ source: string; rawPath: string }> = []
  const envPath = process.env.B2V_CLI_PATH

  if (envPath) {
    candidates.push({ source: 'env', rawPath: envPath })
  } else {
    for (const candidate of getDirectoryCliCandidates(directory)) {
      candidates.push({ source: 'directory', rawPath: candidate })
    }

    // Check cli.path marker file
    const cliPathFile = path.join(getConfigDir(), 'cli.path')
    try {
      const raw = (await fs.readFile(cliPathFile, 'utf8')).trim()
      if (raw) {
        candidates.push({ source: cliPathFile, rawPath: raw })
      }
    } catch {
      // cli.path not found or not executable
    }

    for (const candidate of getBundledCliCandidates()) {
      candidates.push({ source: 'app-sidecar', rawPath: candidate })
    }

    const localBin = path.join(getHomeDir(), '.local/bin/b2v')
    candidates.push({ source: '~/.local/bin', rawPath: localBin })

    const usrLocalBin = '/usr/local/bin/b2v'
    candidates.push({ source: '/usr/local/bin', rawPath: usrLocalBin })

    try {
      const { stdout } = await execFileAsync('which', ['b2v'])
      const whichPath = stdout.trim()
      if (whichPath) {
        candidates.push({ source: 'PATH', rawPath: whichPath })
      }
    } catch {
      // Not in PATH
    }
  }

  for (const candidate of candidates) {
    const resolved = resolveSocketPath(candidate.rawPath)
    if (!resolved) continue

    try {
      await fs.access(resolved, fs.constants.X_OK)
    } catch {
      if (candidate.source === 'env') {
        await logLine(`b2v CLI from env not executable: ${resolved}`)
      }
      continue
    }

    if (requiredCommand && !(await b2vCliSupportsCommand(resolved, requiredCommand))) {
      continue
    }

    await logLine(`b2v CLI resolved from ${candidate.source}: ${resolved}`)
    return resolved
  }

  await logLine('b2v CLI: not found anywhere')
  return null
}

const b2vCliSupportsIpcCall = async (cliPath: string): Promise<boolean> => {
  return b2vCliSupportsCommand(cliPath, 'ipc-call')
}

const ipcRequestViaB2v = async (
  method: string,
  params: Record<string, unknown>,
  socketPath: string,
  timeoutSeconds = 10,
): Promise<{ ok: boolean; response: string | null }> => {
  const cliPath = await resolveB2vCli(undefined, 'ipc-call')
  if (!cliPath) return { ok: false, response: null }
  if (!(await b2vCliSupportsIpcCall(cliPath))) return { ok: false, response: null }

  const request = JSON.stringify({
    id: `ts-${Date.now()}`,
    method,
    params,
  })

  try {
    const { stdout, stderr } = await execFileAsync(
      cliPath,
      [
        'ipc-call',
        '--timeout',
        String(timeoutSeconds),
        '--socket',
        socketPath,
        '--request',
        request,
      ],
      { timeout: (timeoutSeconds + 1) * 1000 },
    )
    const firstLine = stdout.split('\n')[0]?.trim()
    if (firstLine) {
      await logLine(`IPC transport selected: b2v (response_bytes=${firstLine.length})`)
      return { ok: true, response: firstLine }
    }
    if (stderr) {
      await logLine(`b2v transport stderr: ${stderr.slice(0, 500)}`)
    }
    return { ok: false, response: null }
  } catch (error) {
    await logLine(`b2v transport error: ${String(error)}`)
    return { ok: false, response: null }
  }
}

// =============================================================================
// Node.js Socket Transport
// =============================================================================

const ipcRequestViaNodeSocket = async (
  method: string,
  params: Record<string, unknown>,
  socketPath: string,
): Promise<{ ok: boolean; response: string | null }> => {
  const request = JSON.stringify({
    id: `ts-${Date.now()}`,
    method,
    params,
  })

  return new Promise<{ ok: boolean; response: string | null }>((resolve) => {
    let response = ''
    let settled = false

    const settle = (result: { ok: boolean; response: string | null }) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }

    const trySettleWithResponse = () => {
      while (true) {
        const newlineIndex = response.indexOf('\n')
        if (newlineIndex === -1) {
          break
        }

        const line = response.slice(0, newlineIndex).trim()
        response = response.slice(newlineIndex + 1)
        if (!line) {
          continue
        }

        socket.end()
        settle({ ok: true, response: line })
        return
      }

      const trimmed = response.trim()
      if (!trimmed || !trimmed.startsWith('{')) {
        return
      }

      try {
        JSON.parse(trimmed)
        socket.end()
        settle({ ok: true, response: trimmed })
      } catch {
        // Wait for additional chunks when JSON is still partial.
      }
    }

    const socket = net.createConnection(socketPath)
    const timeout = setTimeout(() => {
      settle({ ok: false, response: null })
      socket.destroy()
      void logLine(`node-socket transport: timed out for ${method}`)
    }, 10000)

    socket.on('connect', () => {
      void logLine(`node-socket transport: connected to ${socketPath}`)
      socket.write(`${request}\n`)
    })

    socket.on('data', (data) => {
      response += data.toString()
      trySettleWithResponse()
    })

    socket.on('error', (error) => {
      void logLine(`node-socket transport error for ${method}: ${String(error)}`)
      settle({ ok: false, response: null })
    })

    socket.on('close', () => {
      if (settled) {
        return
      }

      trySettleWithResponse()
      if (!settled) {
        settle({ ok: false, response: null })
      }
    })
  })
}

// =============================================================================
// IPC Request (b2v CLI first, then Node.js socket fallback)
// =============================================================================

const ipcRequest = async (method: string, params: Record<string, unknown>) => {
  const socketPath = await getSocketPath()
  if (!socketPath) {
    await logDebugLine(`IPC request skipped for ${method}: no valid socket path`)
    return { ok: false, response: null }
  }

  await logLine(`IPC request: method=${method}`)

  // Transport 1: b2v CLI
  await logLine('IPC trying transport 1/2: b2v-cli')
  const b2vResult = await ipcRequestViaB2v(method, params, socketPath)
  if (b2vResult.ok && b2vResult.response) {
    return b2vResult
  }
  await logLine('IPC transport b2v-cli: no response')

  // Transport 2: Native Node.js socket (existing implementation)
  await logLine('IPC trying transport 2/2: node-socket')
  const socketResult = await ipcRequestViaNodeSocket(method, params, socketPath)
  if (socketResult.ok && socketResult.response) {
    await logLine(
      `IPC transport selected: node-socket (response_bytes=${socketResult.response.length})`,
    )
    return socketResult
  }
  await logLine('IPC transport node-socket: no response')

  await logLine(`IPC FAILED: all transports returned empty for method=${method}`)
  return { ok: false, response: null }
}

const emitWrapperEvent = async (payload: Record<string, unknown>) => {
  const line = `B2V_EVT ${JSON.stringify(payload)}\n`
  try {
    process.stderr.write(line)
  } catch (error) {
    await logLine(`Wrapper event emit failed: ${String(error)}`)
  }
}

const extractOpencodeServerUrl = (event: Record<string, unknown>) => {
  const properties = asRecord(event.properties)
  const info = asRecord(properties?.info)
  const session = asRecord(event.session)

  const candidates: [string, unknown][] = [
    ['event.server_url', event.server_url],
    ['event.serverUrl', event.serverUrl],
    ['properties.server_url', properties?.server_url],
    ['properties.serverUrl', properties?.serverUrl],
    ['properties.info.server_url', info?.server_url],
    ['properties.info.serverUrl', info?.serverUrl],
    ['session.server_url', session?.server_url],
    ['session.serverUrl', session?.serverUrl],
    ['env.OPENCODE_URL', process.env.OPENCODE_URL],
  ]

  for (const [source, value] of candidates) {
    const resolved = pickString(value)
    if (resolved) {
      return { serverUrl: resolved, source }
    }
  }

  return { serverUrl: undefined, source: null }
}

const extractPromptRequestId = (
  event: Record<string, unknown>,
  options: { includeGenericIds?: boolean } = {},
) => {
  const properties = asRecord(event.properties)
  const info = asRecord(properties?.info)
  const request = asRecord(event.request)
  const permission = asRecord(event.permission)
  const question = asRecord(event.question)
  const genericIds = options.includeGenericIds ? [info?.id, event.id] : []

  return pickString(
    event.requestID,
    event.requestId,
    event.request_id,
    properties?.id,
    properties?.requestID,
    properties?.requestId,
    properties?.request_id,
    info?.requestID,
    info?.requestId,
    info?.request_id,
    request?.requestID,
    request?.requestId,
    request?.request_id,
    request?.id,
    permission?.id,
    question?.id,
    ...genericIds,
  )
}

const getSocketScopedEnv = (socketPath: string | null): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  if (socketPath) {
    env.BACK2V_IPC_SOCKET = socketPath
    env.B2V_IPC_SOCKET = socketPath
  } else {
    delete env.BACK2V_IPC_SOCKET
    delete env.B2V_IPC_SOCKET
  }
  return env
}

const spawnAgentEvent = async (
  cliPath: string,
  args: string[],
  event: Record<string, unknown>,
  socketPath: string | null,
  timeoutMs: number | null = 5000,
): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}> => {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      env: getSocketScopedEnv(socketPath),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    const timeout =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            child.kill()
            reject(new Error(`agent-event CLI timed out after ${timeoutMs}ms`))
          }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timeout ?? undefined)
      reject(err)
    })

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('close', (code, signal) => {
      clearTimeout(timeout ?? undefined)
      resolve({ code, signal, stdout, stderr })
    })

    child.stdin.write(JSON.stringify(event))
    child.stdin.end()
  })
}

const spawnPromptAgentEvent = (
  cliPath: string,
  args: string[],
  event: Record<string, unknown>,
  socketPath: string | null,
) => spawnAgentEvent(cliPath, args, event, socketPath, null)

const dispatchAgentEvent = async (
  directory: string,
  eventType: string,
  event: Record<string, unknown>,
) => {
  const cliPath = await resolveB2vCli(directory, 'agent-event')
  if (!cliPath) return false

  const { serverUrl } = extractOpencodeServerUrl(event)
  const args = ['agent-event', '--agent', AGENT_ID, '--event', eventType]
  if (serverUrl) {
    args.push('--server-url', serverUrl)
  }

  const socketPath = await getSocketPath()
  if (!socketPath) {
    await logLine(`agent-event dispatch skipped without resolved socket: ${eventType}`)
    return false
  }

  try {
    await logLine(`agent-event dispatching via CLI: ${eventType}`)
    const result = await spawnAgentEvent(cliPath, args, event, socketPath)
    if (result.code === 0) {
      await logLine(
        `agent-event CLI dispatch success: ${eventType} (stdout_bytes=${result.stdout.length})`,
      )
      return true
    }
    await logLine(
      `agent-event CLI dispatch returned non-zero (${result.code}): ${eventType} stderr=${result.stderr.trim()}`,
    )
    return false
  } catch (error) {
    await logLine(`agent-event CLI dispatch failed: ${eventType}: ${summarizeProcessError(error)}`)
    return false
  }
}

const isQuestionAnswers = (value: unknown): value is string[][] => {
  return (
    Array.isArray(value) &&
    value.every(
      (answerGroup) =>
        Array.isArray(answerGroup) && answerGroup.every((entry) => typeof entry === 'string'),
    )
  )
}

const parseAgentEventPromptResult = async (
  eventType: string,
  stdout: string,
): Promise<AgentEventPromptResult | null> => {
  const trimmed = stdout.trim()
  if (!trimmed) {
    await logLine(`agent-event returned empty stdout for ${eventType}`)
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    await logLine(`agent-event returned invalid JSON for ${eventType}: ${String(error)}`)
    return null
  }

  if (
    parsed &&
    typeof parsed === 'object' &&
    (parsed as Record<string, unknown>).kind === 'permission' &&
    typeof (parsed as Record<string, unknown>).request_id === 'string' &&
    ((parsed as Record<string, unknown>).reply === 'once' ||
      (parsed as Record<string, unknown>).reply === 'always' ||
      (parsed as Record<string, unknown>).reply === 'reject')
  ) {
    await logLine(
      `agent-event parsed permission payload: event=${eventType} request_id=${(parsed as Record<string, unknown>).request_id} reply=${(parsed as Record<string, unknown>).reply}`,
    )
    return parsed as AgentEventPermissionResult
  }

  if (
    parsed &&
    typeof parsed === 'object' &&
    (parsed as Record<string, unknown>).kind === 'question' &&
    typeof (parsed as Record<string, unknown>).request_id === 'string'
  ) {
    const request_id = (parsed as Record<string, unknown>).request_id as string
    const answers = (parsed as Record<string, unknown>).answers
    const rejected = (parsed as Record<string, unknown>).rejected

    if (rejected === true) {
      await logLine(
        `agent-event parsed question payload: event=${eventType} request_id=${request_id} rejected=true`,
      )
      return {
        kind: 'question',
        request_id,
        rejected: true,
      }
    }

    if (isQuestionAnswers(answers)) {
      await logLine(
        `agent-event parsed question payload: event=${eventType} request_id=${request_id} answers=${answers.length}`,
      )
      return {
        kind: 'question',
        request_id,
        answers,
      }
    }
  }

  await logLine(`agent-event returned unexpected prompt payload for ${eventType}: ${trimmed}`)
  return null
}

const runAgentEventForPrompt = async (
  directory: string,
  eventType: string,
  event: Record<string, unknown>,
  trace?: PromptExecTrace,
): Promise<AgentEventPromptResult | null> => {
  const requestID = trace?.request_id || extractPromptRequestId(event, { includeGenericIds: true })
  const socketPath = await getSocketPath()
  if (!socketPath) {
    await logLine(
      `agent-event prompt pass-through: no valid socket path for ${eventType} request_id=${requestID || '<missing>'}`,
    )
    return {
      kind: 'native_prompt_pass_through',
      request_id: requestID,
    }
  }

  if (!(await canReachSocketPath(socketPath))) {
    await logLine(
      `agent-event prompt pass-through: app IPC unreachable for ${eventType} request_id=${requestID || '<missing>'} socket=${socketPath}`,
    )
    return {
      kind: 'native_prompt_pass_through',
      request_id: requestID,
    }
  }

  const cliPath = await resolveB2vCli(directory, 'agent-event')
  if (!cliPath) {
    await logLine(
      `agent-event prompt pass-through: no supported b2v CLI for ${eventType} request_id=${requestID || '<missing>'}`,
    )
    return {
      kind: 'native_prompt_pass_through',
      request_id: requestID,
    }
  }

  const rawEvent = JSON.stringify(event)
  const args = ['agent-event', '--agent', AGENT_ID, '--event', eventType]
  const { serverUrl, source } = extractOpencodeServerUrl(event)
  if (serverUrl && source) {
    await logDebugLine(`agent-event server_url resolved from ${source}: ${serverUrl}`)
  } else {
    await logDebugLine('agent-event server_url missing after checking event payload and env')
  }
  if (serverUrl) {
    args.push('--server-url', serverUrl)
  }

  const execTrace: PromptExecTrace = {
    exec_id: trace?.exec_id || nextPromptExecId(),
    intercept_id: trace?.intercept_id,
    request_id: requestID,
  }

  const execStartedAt = Date.now()

  await logLine(
    `agent-event prompt exec start: exec_id=${execTrace.exec_id} intercept_id=${execTrace.intercept_id || '<none>'} event=${eventType} request_id=${execTrace.request_id || '<missing>'} active_prompt_intercepts=${activePromptIntercepts.size} cli=${cliPath} args=${JSON.stringify(args)}`,
  )

  const result = await spawnPromptAgentEvent(cliPath, args, event, socketPath).catch((err) => {
    return {
      code: 1,
      signal: null as NodeJS.Signals | null,
      stdout: '',
      stderr: String(err),
    }
  })

  await logLine(
    `agent-event prompt exec complete: exec_id=${execTrace.exec_id} intercept_id=${execTrace.intercept_id || '<none>'} event=${eventType} request_id=${execTrace.request_id || '<missing>'} code=${result.code} signal=${result.signal || 'none'} stdout_bytes=${result.stdout.trim().length} stderr_bytes=${result.stderr.trim().length} duration_ms=${Date.now() - execStartedAt}`,
  )
  if (result.stdout.trim()) {
    await logLine(`agent-event prompt stdout: ${result.stdout.trim().slice(0, 500)}`)
  }
  if (result.stderr.trim()) {
    await logLine(`agent-event prompt stderr: ${result.stderr.trim().slice(0, 500)}`)
  }

  if (result.code !== 0) {
    await logLine(
      `agent-event exited: exec_id=${execTrace.exec_id} intercept_id=${execTrace.intercept_id || '<none>'} request_id=${execTrace.request_id || '<missing>'} code=${result.code} signal=${result.signal || 'none'} cli=${cliPath}`,
    )
    if (result.stderr.trim()) {
      await logLine(`agent-event stderr: ${result.stderr.trim().slice(0, 500)}`)
    }
    return {
      kind: 'native_prompt_pass_through',
      request_id: execTrace.request_id,
    }
  }

  if (!result.stdout.trim()) {
    await logLine(
      `agent-event native prompt pass-through: exec_id=${execTrace.exec_id} intercept_id=${execTrace.intercept_id || '<none>'} event=${eventType} request_id=${execTrace.request_id || '<missing>'}`,
    )
    return {
      kind: 'native_prompt_pass_through',
      request_id: execTrace.request_id,
    }
  }

  return parseAgentEventPromptResult(eventType, result.stdout)
}

const getPromptClientCapabilities = (
  client?: PermissionReplyClient | null,
): PromptClientCapabilities => ({
  permissionReply: typeof client?.permission?.reply === 'function',
  questionReply: typeof client?.question?.reply === 'function',
  questionReject: typeof client?.question?.reject === 'function',
})

const getOwnKeys = (value: unknown) => {
  if ((!value || typeof value !== 'object') && typeof value !== 'function') return []
  return Object.getOwnPropertyNames(value).sort().slice(0, 20)
}

const getPrototypeKeys = (value: unknown) => {
  if ((!value || typeof value !== 'object') && typeof value !== 'function') return []
  const prototype = Object.getPrototypeOf(value)
  if (!prototype) return []
  return Object.getOwnPropertyNames(prototype)
    .filter((key) => key !== 'constructor')
    .sort()
    .slice(0, 20)
}

const summarizePromptClientResource = (
  resource: unknown,
  accessError?: string,
): PromptClientResourceSummary => {
  const summary: PromptClientResourceSummary = {
    own_keys: getOwnKeys(resource),
    proto_keys: getPrototypeKeys(resource),
  }

  if (accessError) {
    summary.access_error = accessError
  }

  if (resource && (typeof resource === 'object' || typeof resource === 'function')) {
    const replyValue = (resource as { reply?: unknown }).reply
    const rejectValue = (resource as { reject?: unknown }).reject
    if (replyValue !== undefined) {
      summary.reply_type = typeof replyValue
    }
    if (rejectValue !== undefined) {
      summary.reject_type = typeof rejectValue
    }
  }

  return summary
}

const summarizePromptClientSurface = (label: string, client?: PermissionReplyClient | null) => {
  let permissionResource: unknown
  let permissionAccessError: string | undefined
  try {
    permissionResource = client?.permission
  } catch (error) {
    permissionAccessError = String(error)
  }

  let questionResource: unknown
  let questionAccessError: string | undefined
  try {
    questionResource = client?.question
  } catch (error) {
    questionAccessError = String(error)
  }

  return {
    label,
    capability: getPromptClientCapabilities(client),
    client_type: client === null ? 'null' : typeof client,
    client_own_keys: getOwnKeys(client),
    client_proto_keys: getPrototypeKeys(client),
    permission: summarizePromptClientResource(permissionResource, permissionAccessError),
    question: summarizePromptClientResource(questionResource, questionAccessError),
  }
}

const logPromptClientSurface = async (label: string, client?: PermissionReplyClient | null) => {
  await logBlock(`prompt client surface: ${label}`, summarizePromptClientSurface(label, client))
}

const summarizeReplyCallResult = (value: unknown) => {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `array(len=${value.length})`
  if (typeof value === 'object') {
    return `object(keys=${Object.getOwnPropertyNames(value).sort().slice(0, 10).join(',')})`
  }
  return `${typeof value}:${String(value)}`
}

const getReplyResultResponse = (value: unknown) => {
  if (!value || typeof value !== 'object') return null
  const response = (value as { response?: unknown }).response
  if (!response || typeof response !== 'object') return null
  return response as {
    ok?: boolean
    status?: number
    url?: string
    clone?: () => { text: () => Promise<string> }
  }
}

const getReplyResultRequest = (value: unknown) => {
  if (!value || typeof value !== 'object') return null
  const request = (value as { request?: unknown }).request
  if (!request || typeof request !== 'object') return null
  return request as { url?: string }
}

const getReplyResultError = (value: unknown) => {
  if (!value || typeof value !== 'object') return undefined
  return (value as { error?: unknown }).error
}

const readReplyResultBody = async (value: unknown) => {
  const response = getReplyResultResponse(value)
  if (!response || typeof response.clone !== 'function') return ''

  try {
    const cloned = response.clone()
    const body = await cloned.text()
    return body.trim().slice(0, 500)
  } catch {
    return ''
  }
}

const logReplyResultDetails = async (
  kind: 'permission' | 'question',
  requestID: string,
  value: unknown,
) => {
  const response = getReplyResultResponse(value)
  const request = getReplyResultRequest(value)
  const error = getReplyResultError(value)
  const status = typeof response?.status === 'number' ? response.status : 'unknown'
  const ok = typeof response?.ok === 'boolean' ? String(response.ok) : 'unknown'
  const url = response?.url || request?.url || '<unknown>'

  await logLine(
    `agent-event ${kind} reply result: request_id=${requestID} status=${status} ok=${ok} url=${url}`,
  )

  if (error !== undefined) {
    await logLine(
      `agent-event ${kind} reply error detail: request_id=${requestID} error=${summarizeReplyCallResult(error)}`,
    )
  }

  const body = await readReplyResultBody(value)
  if (body) {
    await logLine(`agent-event ${kind} reply body: request_id=${requestID} body=${body}`)
  }

  return {
    hasError: error !== undefined,
    ok: response?.ok,
  }
}

const hasAnyPromptClientCapability = (capabilities: PromptClientCapabilities) => {
  return capabilities.permissionReply || capabilities.questionReply || capabilities.questionReject
}

const importOpencodeSdk = async (): Promise<OpencodeSdkModule> => {
  const sdkImporter = (
    globalThis as typeof globalThis & {
      __b2vImportOpencodeSdk?: () => Promise<OpencodeSdkModule>
    }
  ).__b2vImportOpencodeSdk

  if (typeof sdkImporter === 'function') {
    return sdkImporter()
  }

  const sdkSpecifier = '@opencode-ai/sdk'
  return import(/* @vite-ignore */ sdkSpecifier) as Promise<OpencodeSdkModule>
}

const importOpencodeSdkV2Client = async (): Promise<OpencodeSdkModule> => {
  const sdkImporter = (
    globalThis as typeof globalThis & {
      __b2vImportOpencodeSdkV2Client?: () => Promise<OpencodeSdkModule>
    }
  ).__b2vImportOpencodeSdkV2Client

  if (typeof sdkImporter === 'function') {
    return sdkImporter()
  }

  const sdkSpecifier = '@opencode-ai/sdk/v2/client'
  return import(/* @vite-ignore */ sdkSpecifier) as Promise<OpencodeSdkModule>
}

const getProvidedClientTransport = (client?: PermissionReplyClient | null) => {
  if (!client || typeof client !== 'object' || !('_client' in client)) return null
  return client._client ?? null
}
type PromptRequestFetch = (request: Request) => Promise<Response>

const getProvidedPromptRequestFetch = (
  client?: PermissionReplyClient | null,
): PromptRequestFetch | null => {
  const transport = getProvidedClientTransport(client)
  if (
    !transport ||
    typeof transport !== 'object' ||
    !('getConfig' in transport) ||
    typeof transport.getConfig !== 'function'
  ) {
    return null
  }

  try {
    const config = transport.getConfig()
    if (
      !config ||
      typeof config !== 'object' ||
      !('fetch' in config) ||
      typeof config.fetch !== 'function'
    ) {
      return null
    }
    const requestFetch = config.fetch
    return (request) => requestFetch(request)
  } catch {
    return null
  }
}

const adaptProvidedPromptClient = async (client?: PermissionReplyClient | null) => {
  const transport = getProvidedClientTransport(client)
  if (!transport) {
    await logLine('prompt client adaptation skipped: provided client has no _client transport')
    return null
  }

  try {
    const v2SdkModule = await importOpencodeSdkV2Client()
    if (typeof v2SdkModule.OpencodeClient !== 'function') {
      await logLine('prompt client adaptation skipped: v2 OpencodeClient export missing')
      return null
    }

    await logLine(
      'prompt client adaptation: wrapping provided _client transport with v2 OpencodeClient',
    )
    const adaptedClient = new v2SdkModule.OpencodeClient({
      client: transport,
    }) as PermissionReplyClient
    await logPromptClientSurface('adapted-provided-client', adaptedClient)
    const adaptedCapabilities = getPromptClientCapabilities(adaptedClient)
    await logLine(
      `prompt client adaptation result: permission_reply=${adaptedCapabilities.permissionReply} question_reply=${adaptedCapabilities.questionReply} question_reject=${adaptedCapabilities.questionReject}`,
    )

    if (!hasAnyPromptClientCapability(adaptedCapabilities)) {
      await logLine('prompt client adaptation failed: adapted client has no prompt reply methods')
      return null
    }

    return adaptedClient
  } catch (error) {
    await logLine(`prompt client adaptation failed: ${summarizeProcessError(error)}`)
    return null
  }
}

const createSdkPromptClient = async (directory: string, serverUrl?: URL | null) => {
  if (!serverUrl) {
    await logLine('prompt client fallback unavailable: missing serverUrl')
    return null
  }

  try {
    await logLine(`prompt client fallback: creating OpenCode SDK root client base_url=${serverUrl}`)
    const sdkModule = await importOpencodeSdk()
    if (typeof sdkModule.createOpencodeClient !== 'function') {
      await logLine('prompt client fallback failed: root createOpencodeClient export missing')
    } else {
      const rootClient = sdkModule.createOpencodeClient({
        baseUrl: serverUrl.toString(),
        directory,
      }) as PermissionReplyClient
      await logPromptClientSurface('root-sdk-client', rootClient)
      const rootCapabilities = getPromptClientCapabilities(rootClient)
      await logLine(
        `prompt client fallback root result: permission_reply=${rootCapabilities.permissionReply} question_reply=${rootCapabilities.questionReply} question_reject=${rootCapabilities.questionReject}`,
      )

      if (hasAnyPromptClientCapability(rootCapabilities)) {
        return rootClient
      }
    }

    await logLine(`prompt client fallback: creating OpenCode SDK v2 client base_url=${serverUrl}`)
    const v2SdkModule = await importOpencodeSdkV2Client()
    if (typeof v2SdkModule.createOpencodeClient !== 'function') {
      await logLine('prompt client fallback failed: v2 createOpencodeClient export missing')
      return null
    }

    const v2Client = v2SdkModule.createOpencodeClient({
      baseUrl: serverUrl.toString(),
      directory,
    }) as PermissionReplyClient
    await logPromptClientSurface('v2-sdk-client', v2Client)
    const v2Capabilities = getPromptClientCapabilities(v2Client)
    await logLine(
      `prompt client fallback v2 result: permission_reply=${v2Capabilities.permissionReply} question_reply=${v2Capabilities.questionReply} question_reject=${v2Capabilities.questionReject}`,
    )

    if (!hasAnyPromptClientCapability(v2Capabilities)) {
      await logLine('prompt client fallback failed: SDK clients have no prompt reply methods')
      return null
    }

    return v2Client
  } catch (error) {
    await logLine(`prompt client fallback failed: ${summarizeProcessError(error)}`)
    return null
  }
}

const resolvePromptReplyRequestID = async (
  kind: 'permission' | 'question',
  originalRequestID: string,
  resultRequestID: string,
) => {
  if (originalRequestID && resultRequestID && originalRequestID !== resultRequestID) {
    await logLine(
      `${kind} request id mismatch: original=${originalRequestID} result=${resultRequestID}; ignoring mismatched reply`,
    )
    return null
  }

  return originalRequestID || resultRequestID || null
}

const sendPromptReplyDirect = async (
  effectiveServerUrl: URL,
  directory: string,
  pathName: string,
  body?: Record<string, unknown>,
  requestFetch?: PromptRequestFetch,
) => {
  const request = (path: string) => {
    const url = new URL(path, effectiveServerUrl)
    url.searchParams.set('directory', directory)
    const init: RequestInit = {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }
    return requestFetch ? requestFetch(new Request(url, init)) : fetch(url, init)
  }

  let response = await request(pathName)
  if (response.status === 404 && pathName.endsWith('/reply')) {
    response = await request(pathName.slice(0, -'/reply'.length))
  }
  if (!response.ok) {
    throw new Error(`OpenCode direct prompt reply failed: HTTP ${response.status}`)
  }
}

type SessionStatusContext = {
  agentId?: string
  cwd?: string
  bundleId?: string
  requestId?: string
  explicitCompletion?: boolean
  terminalTabId?: string
  tmux?: TmuxSnapshot | null
  parentId?: string
  parentSessionHash?: string
}

type TerminalIdentityPolicy = {
  trustEnv: boolean
}

type SessionStatusResult = {
  rowsAffected: number
  deduped: boolean
  suppressed: boolean
  ipcOk: boolean
}

const defaultSessionStatusResult = (): SessionStatusResult => ({
  rowsAffected: 0,
  deduped: false,
  suppressed: false,
  ipcOk: false,
})

const pickNumber = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return 0
}

const parseSessionStatusResult = (response: string | null): SessionStatusResult => {
  if (!response) return defaultSessionStatusResult()

  try {
    const parsed = JSON.parse(response) as unknown
    const root = asRecord(parsed)
    const result = asRecord(root?.result) || root
    if (!result) return defaultSessionStatusResult()

    return {
      rowsAffected: pickNumber(result.rows_affected, result.rowsAffected),
      deduped: pickBool(result.deduped),
      suppressed: pickBool(result.suppressed),
      ipcOk: true,
    }
  } catch {
    return defaultSessionStatusResult()
  }
}

const setSessionStatus = async (
  sessionHash: string | undefined,
  status: 'busy' | 'idle' | 'waiting',
  context: SessionStatusContext = {},
): Promise<SessionStatusResult> => {
  await logBlock(
    `[IPC][setSessionStatus] call sessionHash=${sessionHash} status=${status}`,
    context,
  )
  if (!sessionHash) return defaultSessionStatusResult()
  const params: Record<string, unknown> = {
    session_hash: sessionHash,
    status,
  }

  if (context.agentId) {
    params.agent_id = context.agentId
  }

  if (context.cwd) {
    params.cwd = context.cwd
  }

  const sshSession = await resolveSshEnvForCurrentTty()
  const trustEnvTerminalIdentity = shouldTrustEnvTerminalIdentity(context.tmux || null, sshSession)

  if (trustEnvTerminalIdentity && context.bundleId) {
    params.bundle_id = context.bundleId
  }

  if (context.requestId) {
    params.request_id = context.requestId
  }

  if (context.explicitCompletion) {
    params.explicit_completion = true
  }

  if (context.parentId) {
    params.parent_id = context.parentId
  }

  if (context.parentSessionHash) {
    params.parent_session_hash = context.parentSessionHash
  }

  if (trustEnvTerminalIdentity && context.terminalTabId) {
    params.terminal_tab_id = context.terminalTabId
  }

  if (context.isTyping !== undefined) {
    params.is_typing = context.isTyping
  }

  if (context.isBusy !== undefined) {
    params.is_busy = context.isBusy
  }

  if (context.tmux) {
    if (context.tmux.sessionName) {
      params.tmux_session_name = context.tmux.sessionName
    }
    if (context.tmux.paneId) {
      params.tmux_pane_id = context.tmux.paneId
    }
    if (context.tmux.windowId) {
      params.tmux_window_id = context.tmux.windowId
    }
    if (context.tmux.windowName) {
      params.tmux_window_name = context.tmux.windowName
    }
    const tmuxWindowIndex = parseOptionalInt(context.tmux.windowIndex)
    if (tmuxWindowIndex !== null) {
      params.tmux_window_index = tmuxWindowIndex
    }
    const tmuxPaneIndex = parseOptionalInt(context.tmux.paneIndex)
    if (tmuxPaneIndex !== null) {
      params.tmux_pane_index = tmuxPaneIndex
    }
    const tmuxClientPid = parseOptionalInt(context.tmux.clientPid)
    if (tmuxClientPid !== null) {
      params.tmux_client_pid = tmuxClientPid
    }
  }

  applySshContext(params, sshSession)
  applyTmuxChainContext(params, context.tmux || null, sshSession)
  params.runtime_terminal_input = buildRuntimeTerminalInput(context.tmux || null, sshSession)

  const response = await ipcRequest('set_session_status', params)
  return parseSessionStatusResult(response.response)
}

const resolveFocusedBundleId = (
  app: Record<string, unknown> | null | undefined,
  policy: TerminalIdentityPolicy = { trustEnv: true },
) => {
  return (
    normalizeExpectedBundleIdHint(app?.bundle_id) ||
    normalizeExpectedBundleIdHint(app?.__CFBundleIdentifier) ||
    (policy.trustEnv ? resolveExpectedBundleIdHint() : undefined)
  )
}

type LicenseState = 'pro' | 'non_pro' | 'check_failed'

const checkLicenseState = async (): Promise<LicenseState> => {
  const result = await ipcRequest('check_license_status', {})
  if (!result.ok || !result.response) return 'check_failed'
  try {
    const parsed = JSON.parse(result.response)
    const data = parsed.result || parsed
    const tier =
      typeof data?.tier === 'string'
        ? data.tier.trim().toLowerCase()
        : typeof data?.status === 'string'
          ? data.status.trim().toLowerCase()
          : ''
    if (tier === 'pro') return 'pro'
    if (tier) return 'non_pro'
    return 'check_failed'
  } catch {
    return 'check_failed'
  }
}

let cachedDefaultApp: string | null = null

const getFocusState = async () => {
  const result = await ipcRequest('get_focus_state', { agent_id: AGENT_ID })
  const state = { globalEnabled: true, agentEnabled: true, soundMuted: false }
  if (!result.ok || !result.response) return state

  try {
    const parsed = JSON.parse(result.response)
    const data = parsed.result || parsed
    state.globalEnabled = data.global_enabled ?? true
    state.agentEnabled = data.agent_enabled ?? true
    state.soundMuted = data.sound_muted ?? false
    if (typeof data.default_app === 'string' && data.default_app.trim()) {
      cachedDefaultApp = data.default_app.trim()
    }
  } catch {
    // Ignore parse errors, return default state
  }
  return state
}

const asRecord = (value: unknown) => {
  if (!value || typeof value !== 'object') return undefined
  return value as Record<string, unknown>
}

const pickString = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

const summarizePromptTarget = (event: Record<string, unknown>) => {
  const properties = asRecord(event.properties)
  const metadata = asRecord(properties?.metadata)
  const patterns = Array.isArray(properties?.patterns)
    ? properties.patterns.filter((value): value is string => typeof value === 'string')
    : []

  return (
    pickString(metadata?.filepath, metadata?.parentDir, patterns[0], properties?.permission) ||
    '<unknown>'
  )
}

const summarizeActivePromptIntercepts = () => {
  const values = Array.from(activePromptIntercepts.values())
    .sort((left, right) => left.started_at_ms - right.started_at_ms)
    .map(
      (trace) =>
        `${trace.intercept_id}:${trace.event_type}:${trace.request_id || '<missing>'}:${trace.target}`,
    )

  return values.length ? values.join('|') : '<none>'
}

const registerPromptIntercept = async (eventType: string, event: Record<string, unknown>) => {
  const trace: PromptInterceptTrace = {
    intercept_id: nextPromptInterceptId(),
    event_type: eventType,
    request_id: extractPromptRequestId(event, { includeGenericIds: true }),
    session_id: extractSessionId(event) || '<missing>',
    target: summarizePromptTarget(event),
    started_at_ms: Date.now(),
  }

  activePromptIntercepts.set(trace.intercept_id, trace)
  await logLine(
    `prompt intercept enter: intercept_id=${trace.intercept_id} type=${trace.event_type} request_id=${trace.request_id || '<missing>'} session_id=${trace.session_id} target=${trace.target} active_count=${activePromptIntercepts.size} active=${summarizeActivePromptIntercepts()}`,
  )

  return trace
}

const completePromptIntercept = async (
  trace: PromptInterceptTrace,
  outcome: string,
  extra: Record<string, unknown> = {},
) => {
  const durationMs = Date.now() - trace.started_at_ms
  const extras = Object.entries(extra)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')
  await logLine(
    `prompt intercept exit: intercept_id=${trace.intercept_id} type=${trace.event_type} request_id=${trace.request_id || '<missing>'} outcome=${outcome} duration_ms=${durationMs} active_before_remove=${activePromptIntercepts.size}${extras ? ` ${extras}` : ''}`,
  )
  activePromptIntercepts.delete(trace.intercept_id)
  await logLine(
    `prompt intercept active after exit: intercept_id=${trace.intercept_id} active_count=${activePromptIntercepts.size} active=${summarizeActivePromptIntercepts()}`,
  )
}

const hasControlCharacter = (value: string) => {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }

  return false
}

const sanitizeLogValue = (value: unknown, maxLength = 256) => {
  const raw = typeof value === 'string' ? value : String(value ?? '')
  const cleaned = Array.from(raw, (char) => {
    const code = char.charCodeAt(0)
    return code <= 0x1f || code === 0x7f ? '?' : char
  }).join('')
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned
}

const normalizeExpectedBundleIdHint = (value: unknown) => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 512 || hasControlCharacter(trimmed)) return undefined
  return trimmed
}

const normalizeTerminalProgramHint = (value: unknown) => {
  if (typeof value !== 'string') return ''
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  return normalized
}

const terminalBundleIdFromProgramHint = (value: unknown) => {
  switch (normalizeTerminalProgramHint(value)) {
    case 'ghostty':
      return 'com.mitchellh.ghostty'
    case 'alacritty':
      return 'org.alacritty'
    case 'hyper':
    case 'hyperapp':
      return 'co.zeit.hyper'
    case 'zellij':
      return 'org.zellij'
    case 'kitty':
      return 'net.kovidgoyal.kitty'
    case 'wezterm':
    case 'weztermgui':
      return 'com.github.wez.wezterm'
    case 'warp':
    case 'warpterminal':
      return 'dev.warp.Warp-Stable'
    case 'warppreview':
      return 'dev.warp.Warp-Preview'
    case 'tabby':
    case 'tabbyapp':
      return 'org.tabby.app'
    case 'rio':
      return 'com.rioapp.Rio'
    case 'contour':
      return 'com.contour.app'
    case 'iterm':
    case 'iterm2':
    case 'itermapp':
      return 'com.googlecode.iterm2'
    case 'terminal':
    case 'appleterminal':
      return 'com.apple.Terminal'
    default:
      return undefined
  }
}

const terminalBundleIdFromTermValue = (value: unknown) => {
  const normalized = normalizeTerminalProgramHint(value)
  if (!normalized) return undefined
  if (normalized.includes('ghostty')) return 'com.mitchellh.ghostty'
  if (normalized.includes('wezterm')) return 'com.github.wez.wezterm'
  if (normalized.includes('kitty')) return 'net.kovidgoyal.kitty'
  if (normalized.includes('alacritty')) return 'org.alacritty'
  return undefined
}

const nonEmptyEnvString = (name: string) => {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}
const nonEmptyEnvNumber = (name: string) => {
  const value = nonEmptyEnvString(name)
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const buildTerminalEnvFromBundleId = (bundleId?: string) => {
  switch (bundleId?.trim()) {
    case 'com.googlecode.iterm2': {
      const sessionId = getTerminalTabIdFromEnv()
      return sessionId ? { iterm_session_id: sessionId } : undefined
    }
    case 'com.cmuxterm.app': {
      const workspaceId = nonEmptyEnvString('CMUX_WORKSPACE_ID')
      const surfaceId = nonEmptyEnvString('CMUX_SURFACE_ID')
      const socketPath = nonEmptyEnvString('CMUX_SOCKET_PATH')
      if (!workspaceId && !surfaceId && !socketPath) return undefined
      return {
        cmux_workspace_id: workspaceId,
        cmux_surface_id: surfaceId,
        cmux_socket_path: socketPath,
      }
    }
    case 'org.zellij': {
      const paneId = nonEmptyEnvString('ZELLIJ_PANE_ID')
      const sessionName = nonEmptyEnvString('ZELLIJ_SESSION_NAME')
      if (!paneId && !sessionName) return undefined
      return {
        zellij_pane_id: paneId,
        zellij_session_name: sessionName,
      }
    }
    case 'com.github.wez.wezterm': {
      const paneId = nonEmptyEnvNumber('WEZTERM_PANE')
      const unixSocket = nonEmptyEnvString('WEZTERM_UNIX_SOCKET')
      if (paneId === undefined && !unixSocket) return undefined
      return {
        wezterm_pane: paneId,
        wezterm_unix_socket: unixSocket,
      }
    }
    case 'net.kovidgoyal.kitty': {
      const windowId = nonEmptyEnvNumber('KITTY_WINDOW_ID')
      const listenOn = nonEmptyEnvString('KITTY_LISTEN_ON')
      const osWindowId = nonEmptyEnvNumber('WINDOWID')
      if (windowId === undefined && !listenOn && osWindowId === undefined) return undefined
      return {
        kitty_window_id: windowId,
        kitty_listen_on: listenOn,
        os_window_id: osWindowId,
      }
    }
    default:
      return undefined
  }
}

const resolveExpectedBundleIdHint = () => {
  const explicitBundleId = normalizeExpectedBundleIdHint(process.env.__CFBundleIdentifier)
  if (explicitBundleId) return explicitBundleId

  const envBundleId =
    terminalBundleIdFromProgramHint(process.env.TERM_PROGRAM) ||
    terminalBundleIdFromProgramHint(process.env.TERM_PROGRAM_NAME) ||
    terminalBundleIdFromProgramHint(process.env.LC_TERMINAL)
  if (envBundleId) return envBundleId

  return terminalBundleIdFromTermValue(process.env.TERM)
}

const normalizeItermSessionId = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith(':')) return ''
  if (trimmed.endsWith(':')) return ''

  const candidate = trimmed.includes(':') ? (trimmed.split(':').at(-1) || '').trim() : trimmed
  if (!candidate) return ''
  if (candidate.length > 512) return ''
  if (hasControlCharacter(candidate)) return ''
  return candidate
}

const getTerminalTabIdFromEnv = () => {
  if (process.env.__CFBundleIdentifier !== 'com.googlecode.iterm2') return ''
  const raw = pickString(process.env.ITERM_SESSION_ID)
  if (!raw) return ''
  return normalizeItermSessionId(raw)
}

const buildRuntimeTerminalInput = (
  tmux: TmuxSnapshot | null,
  sshSession: SshSessionEnv | null,
): Record<string, unknown> => {
  const input: Record<string, unknown> = {
    inside_tmux: isInsideTmux(tmux),
    is_remote: hasSshRoutingMetadata(sshSession),
  }
  const clientPid = parseOptionalInt(tmux?.clientPid)
  if (clientPid !== null) input.tmux_client_pid = clientPid
  const envBundleId = resolveExpectedBundleIdHint()
  if (envBundleId) input.env_bundle_id = envBundleId
  const envTerminalEnv = buildTerminalEnvFromBundleId(envBundleId)
  if (envTerminalEnv) input.env_terminal_env = envTerminalEnv
  const envTabId = getTerminalTabIdFromEnv()
  if (envTabId) input.env_terminal_tab_id = envTabId
  return input
}

const isInsideTmux = (tmux: TmuxSnapshot | null | undefined) => Boolean(tmux || process.env.TMUX)

const shouldTrustEnvTerminalIdentity = (
  tmux: TmuxSnapshot | null | undefined,
  sshSession: SshSessionEnv | null,
) => !isInsideTmux(tmux) || hasSshRoutingMetadata(sshSession)

const pickBool = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (value === 1) return true
      if (value === 0) return false
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true
      if (['false', '0', 'no', 'off', ''].includes(normalized)) return false
    }
  }
  return false
}

const subagentSessionIds = new Set<string>()

// OpenCode's busy/retry session.status events are weak signals. Treat a main
// idle/completion signal as authoritative and quarantine weak busy signals long
// enough for subagent/event-burst noise to settle.
const BUSY_IDLE_REQUEST_GUARD_MS = 3000
const RECENT_IDLE_REQUEST_MAX_ENTRIES = 256
const recentIdleRequestBySession = new Map<string, { requestId: string; seenAt: number }>()
const directBusyStatusBySession = new Set<string>()

const pruneRecentIdleRequests = (now: number) => {
  const cutoff = now - BUSY_IDLE_REQUEST_GUARD_MS * 2
  recentIdleRequestBySession.forEach((entry, sessionHash) => {
    if (entry.seenAt < cutoff) recentIdleRequestBySession.delete(sessionHash)
  })
  while (recentIdleRequestBySession.size > RECENT_IDLE_REQUEST_MAX_ENTRIES) {
    const oldestSessionHash = recentIdleRequestBySession.keys().next().value
    if (!oldestSessionHash) break
    recentIdleRequestBySession.delete(oldestSessionHash)
  }
}

const recordSessionIdleRequest = (sessionHash: string | undefined, requestId: string) => {
  if (!sessionHash) return
  const now = Date.now()
  recentIdleRequestBySession.set(sessionHash, { requestId: requestId || '', seenAt: now })
  pruneRecentIdleRequests(now)
}

const isBusyForRecentIdleRequest = (
  sessionHash: string | undefined,
  requestId: string,
): boolean => {
  if (!sessionHash) return false
  const recent = recentIdleRequestBySession.get(sessionHash)
  if (!recent || Date.now() - recent.seenAt >= BUSY_IDLE_REQUEST_GUARD_MS) return false
  return true
}

const FOCUS_EVENT_DEDUPE_MS = 1200
const INTERACTION_EVENT_NOTIFICATION_TYPES = new Map([
  ['permission.asked', 'PermissionAsked'],
  ['question.asked', 'QuestionAsked'],
])
const SESSION_START_EVENT_TYPES = new Set([
  'session.created',
  'session.start',
  'session_start',
  'sessionstart',
])
const SESSION_END_EVENT_TYPES = new Set([
  'session.deleted',
  'session_end',
  'server.instance.disposed',
])
const recentFocusEventByKey = new Map<string, number>()
const inFlightFocusEvents = new Map<string, Promise<void>>()

const summarizeEventRouting = (
  eventType: string,
  event: Record<string, unknown>,
  sessionHash: string | undefined,
  cwd: string,
  wrapperMode: boolean,
) => {
  const summary: Record<string, unknown> = {
    wrapper_mode: wrapperMode,
    focus_candidate: isFocusCandidateEvent(eventType, event),
    session_start_candidate: SESSION_START_EVENT_TYPES.has(eventType),
    session_end_candidate: SESSION_END_EVENT_TYPES.has(eventType),
    focus_event_key: getFocusEventKey(eventType, sessionHash, cwd) || undefined,
    parent_marker: extractParentMarker(event) || undefined,
  }

  if (isFocusCandidateEvent(eventType, event)) {
    summary.typing = extractTypingSignals(event)
  }

  return summary
}

const getSessionStatusType = (event: Record<string, unknown>) => {
  const properties = asRecord(event.properties)
  const session = asRecord(event.session)
  const info = asRecord(properties?.info)

  // 1. Check direct status string in various places
  const rawStatus = pickString(properties?.status, session?.status, event.status, info?.status)

  if (rawStatus) {
    return rawStatus.trim().toLowerCase()
  }

  // 2. Check status object (common in some event formats)
  const statusObj = asRecord(properties?.status || session?.status || event.status)
  if (statusObj) {
    return pickString(statusObj.type, statusObj.name, statusObj.id).trim().toLowerCase()
  }

  return ''
}

type LifecycleSignal = 'busy' | 'waiting' | 'idle' | null

const getLifecycleSignal = (eventType: string, event: Record<string, unknown>): LifecycleSignal => {
  if (SESSION_END_EVENT_TYPES.has(eventType)) return null

  const statusType = getSessionStatusType(event)

  if (eventType === 'session.idle' || eventType === 'session_completed' || statusType === 'idle') {
    return 'idle'
  }

  if (statusType === 'waiting' || isInteractionPromptEvent(eventType, event)) {
    return 'waiting'
  }

  // session.status can be noisy, but we still accept explicit busy/retry signals
  // so waiting -> working can recover from streamed status events.
  // Unknown session.status payloads remain a no-op.
  if (eventType === 'session.status' && statusType !== 'busy' && statusType !== 'retry') {
    return null
  }

  if (statusType === 'busy' || statusType === 'retry') return 'busy'

  // Explicit activity signals
  const typing = extractTypingSignals(event)
  if (
    typing.isBusy ||
    typing.isTyping ||
    SESSION_START_EVENT_TYPES.has(eventType) ||
    eventType === 'session.message' ||
    eventType === 'activity'
  ) {
    return 'busy'
  }

  // Known busy event patterns
  if (
    eventType.includes('tool.') ||
    eventType.includes('shell.') ||
    eventType.includes('command.')
  ) {
    return 'busy'
  }

  // For unknown event types, we no longer default to "busy".
  // This prevents random metadata/telemetry events from resetting an "idle" session.
  return null
}

const shouldTriggerFocusForEvent = (eventType: string, event: Record<string, unknown>) => {
  const lifecycleSignal = getLifecycleSignal(eventType, event)
  return lifecycleSignal === 'waiting' || lifecycleSignal === 'idle'
}

const shouldSuppressFocusDelivery = (eventType: string) => {
  return eventType === 'session.awaiting_input' || eventType === 'session.awaiting-input'
}

const isIdleStatusEvent = (eventType: string, event: Record<string, unknown>) => {
  const statusType = getSessionStatusType(event)
  return eventType === 'session.idle' || eventType === 'session_completed' || statusType === 'idle'
}

const isExplicitCompletionEvent = (eventType: string, event: Record<string, unknown>) => {
  const normalizedEventType = eventType.trim().toLowerCase()
  if (
    normalizedEventType === 'session.idle' ||
    normalizedEventType === 'session_completed' ||
    normalizedEventType === 'stop' ||
    normalizedEventType === 'after_agent' ||
    normalizedEventType === 'agent_stop' ||
    normalizedEventType === 'idle'
  ) {
    return true
  }

  const hookEventName = pickString(event.hook_event_name, event.hookEventName).trim().toLowerCase()
  return (
    hookEventName === 'stop' ||
    hookEventName === 'afteragent' ||
    hookEventName === 'after_agent' ||
    hookEventName === 'agentstop' ||
    hookEventName === 'agent_stop'
  )
}

const isInteractionPromptEvent = (eventType: string, _event: Record<string, unknown>) => {
  return (
    INTERACTION_EVENT_NOTIFICATION_TYPES.has(eventType) ||
    eventType === 'session.awaiting_input' ||
    eventType === 'session.awaiting-input'
  )
}

const getInteractionPromptNotificationType = (
  eventType: string,
  _event: Record<string, unknown>,
) => {
  const directNotificationType = INTERACTION_EVENT_NOTIFICATION_TYPES.get(eventType)
  if (directNotificationType) {
    return directNotificationType
  }
  return undefined
}

const isFocusCandidateEvent = (eventType: string, event: Record<string, unknown>) => {
  return shouldTriggerFocusForEvent(eventType, event)
}

const getFocusEventKey = (
  eventType: string,
  sessionHash?: string,
  cwd?: string,
  status?: string,
) => {
  if (!sessionHash && !cwd) return null

  const normalizedSession = sessionHash?.trim() || ''
  const normalizedCwd = cwd?.trim() || ''
  const normalizedStatus = status?.trim() || ''

  return `${eventType}:${normalizedSession || normalizedCwd}:${normalizedStatus}`
}

const pruneRecentFocusEvents = (now: number) => {
  if (recentFocusEventByKey.size <= 128) return
  const cutoff = now - FOCUS_EVENT_DEDUPE_MS * 5
  for (const [candidate, timestamp] of recentFocusEventByKey.entries()) {
    if (timestamp < cutoff) {
      recentFocusEventByKey.delete(candidate)
    }
  }
}

const shouldCoalesceFocusEvent = (
  eventType: string,
  sessionHash?: string,
  cwd?: string,
  status?: string,
) => {
  const key = getFocusEventKey(eventType, sessionHash, cwd, status)
  if (!key) return false

  const now = Date.now()
  const lastSeen = recentFocusEventByKey.get(key)

  return typeof lastSeen === 'number' && now - lastSeen < FOCUS_EVENT_DEDUPE_MS
}

const isFocusEventInFlight = (
  eventType: string,
  sessionHash?: string,
  cwd?: string,
  status?: string,
) => {
  const key = getFocusEventKey(eventType, sessionHash, cwd, status)
  if (!key) return false
  return inFlightFocusEvents.has(key)
}

const waitForInFlightFocusEvent = async (
  eventType: string,
  sessionHash?: string,
  cwd?: string,
  status?: string,
) => {
  const key = getFocusEventKey(eventType, sessionHash, cwd, status)
  if (!key) return

  const pending = inFlightFocusEvents.get(key)
  if (!pending) return

  try {
    await pending
  } catch {
    // Focus handlers should not reject, but a failed wait should not block retries.
  }
}

const registerInFlightFocusEvent = (key: string) => {
  let resolvePending!: () => void
  const pending = new Promise<void>((resolve) => {
    resolvePending = resolve
  })
  inFlightFocusEvents.set(key, pending)

  return () => {
    if (inFlightFocusEvents.get(key) === pending) {
      inFlightFocusEvents.delete(key)
    }
    resolvePending()
  }
}

const markFocusEventHandled = (
  eventType: string,
  sessionHash?: string,
  cwd?: string,
  status?: string,
) => {
  const key = getFocusEventKey(eventType, sessionHash, cwd, status)
  if (!key) return

  const now = Date.now()
  recentFocusEventByKey.set(key, now)
  pruneRecentFocusEvents(now)
}

// OpenCode `message.updated` events carry an AssistantMessage in
// `properties.info`, and that message has a `parentID` field that refers to
// the parent MESSAGE in the conversation thread (the user message that
// prompted this assistant message). It has nothing to do with subagent
// session parentage. If we accept it as a session-parent marker, every
// session that has any assistant message gets poisoned into
// `subagentSessionIds` and all later events (including `session.idle`) are
// silently dropped via the `skipSubagentHookEvent` branch. Filter those out.
const isOpencodeMessageId = (value: string | undefined | null): boolean =>
  typeof value === 'string' && (value.startsWith('msg_') || value.startsWith('msg-'))

const extractParentMarker = (event: Record<string, unknown>) => {
  const properties = asRecord(event.properties)
  const info = asRecord(properties?.info)
  const session = asRecord(event.session)
  const body = asRecord(event.body)

  const candidate = pickString(
    info?.parentID,
    info?.parentId,
    info?.parent_id,
    session?.parentID,
    session?.parentId,
    session?.parent_id,
    body?.parentID,
    body?.parentId,
    body?.parent_id,
    properties?.parentID,
    properties?.parentId,
    properties?.parent_id,
    event.parentID,
    event.parentId,
    event.parent_id,
    info?.parentAgent,
    info?.parent_agent,
    session?.parentAgent,
    session?.parent_agent,
    body?.parentAgent,
    body?.parent_agent,
    properties?.parentAgent,
    properties?.parent_agent,
    event.parentAgent,
    event.parent_agent,
  )

  if (isOpencodeMessageId(candidate)) return ''
  return candidate
}

const extractParentSessionHash = (event: Record<string, unknown>) => {
  const properties = asRecord(event.properties)
  const info = asRecord(properties?.info)
  const session = asRecord(event.session)
  const body = asRecord(event.body)

  const candidate = pickString(
    info?.parent_session_hash,
    info?.parentSessionHash,
    session?.parent_session_hash,
    session?.parentSessionHash,
    body?.parent_session_hash,
    body?.parentSessionHash,
    properties?.parent_session_hash,
    properties?.parentSessionHash,
    event.parent_session_hash,
    event.parentSessionHash,
  )

  if (isOpencodeMessageId(candidate)) return ''
  return candidate
}

const extractSubagentMode = (event: Record<string, unknown>) => {
  const properties = asRecord(event.properties)
  const info = asRecord(properties?.info)
  const session = asRecord(event.session)
  const body = asRecord(event.body)
  const agent = asRecord(event.agent)
  const agentConfig = asRecord(event.agentConfig)

  return pickString(
    info?.mode,
    session?.mode,
    body?.mode,
    agent?.mode,
    agentConfig?.mode,
    properties?.mode,
    event.mode,
  )
    .trim()
    .toLowerCase()
}

const shouldSkipSubagentHooks = (
  eventType: string,
  event: Record<string, unknown>,
  sessionId?: string,
) => {
  const resolvedSessionId = sessionId || extractSessionId(event)
  const parentMarker = extractParentSessionHash(event) || extractParentMarker(event)
  const subagentMode = extractSubagentMode(event)
  const isSubagentMode = subagentMode === 'subagent'

  if ((parentMarker || isSubagentMode) && resolvedSessionId) {
    subagentSessionIds.add(resolvedSessionId)
  }

  if (
    (eventType === 'session.deleted' ||
      eventType === 'session_end' ||
      eventType === 'server.instance.disposed') &&
    resolvedSessionId
  ) {
    subagentSessionIds.delete(resolvedSessionId)
  }

  const lifecycleSignal = getLifecycleSignal(eventType, event)
  if (lifecycleSignal === 'waiting') {
    return false
  }

  const skip =
    Boolean(parentMarker) ||
    isSubagentMode ||
    (resolvedSessionId ? subagentSessionIds.has(resolvedSessionId) : false)

  if (DEBUG_EVENTS && eventType.includes('idle')) {
    void logLine(
      `[agent-event-debug] shouldSkipSubagentHooks eventType=${eventType} sessionId=${resolvedSessionId} parentMarker=${parentMarker} isSubagentMode=${isSubagentMode} skip=${skip}`,
    )
  }

  return skip
}

const extractSessionId = (event: Record<string, unknown>) => {
  const session = asRecord(event.session)
  const properties = asRecord(event.properties)
  const propertiesInfo = asRecord(properties?.info)

  const candidate = pickString(
    event.session_id,
    event.sessionId,
    event.session_hash,
    event.sessionHash,
    session?.session_id,
    session?.id,
    session?.hash,
    properties?.sessionID,
    properties?.session_id,
    properties?.sessionId,
    propertiesInfo?.sessionID,
    event.conversation_id,
  )

  if (candidate) return candidate

  const fallback = pickString(propertiesInfo?.id, event.id)
  if (
    fallback &&
    !fallback.startsWith('msg_') &&
    !fallback.startsWith('msg-') &&
    !fallback.startsWith('evt_') &&
    !fallback.startsWith('evt-') &&
    !fallback.startsWith('tool_') &&
    !fallback.startsWith('tool-') &&
    !fallback.startsWith('run_') &&
    !fallback.startsWith('run-')
  ) {
    return fallback
  }

  return undefined
}

const eventWithSessionId = (event: Record<string, unknown>, sessionHash?: string) => {
  if (!sessionHash || extractSessionId(event)) return event
  return { ...event, session_id: sessionHash }
}

const extractCwd = (event: Record<string, unknown>, directory?: string) => {
  const project = asRecord(event.project)
  return pickString(event.cwd, event.directory, project?.root, directory)
}

const extractTypingSignals = (event: Record<string, unknown>) => {
  const properties = asRecord(event.properties)
  const propertiesInfo = asRecord(properties?.info)
  const propertiesContext = asRecord(properties?.context)
  const info = asRecord(event.info)
  const session = asRecord(event.session)
  const payload = asRecord(event.payload)
  const payloadInfo = asRecord(payload?.info)
  const data = asRecord(event.data)
  const dataInfo = asRecord(data?.info)
  const metadata = asRecord(event.metadata)
  const metadataInfo = asRecord(metadata?.info)
  const context = asRecord(event.context)

  return {
    isBusy: pickBool(
      propertiesInfo?.is_busy,
      propertiesInfo?.isBusy,
      propertiesContext?.is_busy,
      propertiesContext?.isBusy,
      properties?.is_busy,
      properties?.isBusy,
      info?.is_busy,
      info?.isBusy,
      payloadInfo?.is_busy,
      payloadInfo?.isBusy,
      payload?.is_busy,
      payload?.isBusy,
      dataInfo?.is_busy,
      dataInfo?.isBusy,
      data?.is_busy,
      data?.isBusy,
      metadataInfo?.is_busy,
      metadataInfo?.isBusy,
      metadata?.is_busy,
      metadata?.isBusy,
      context?.is_busy,
      context?.isBusy,
      event.is_busy,
      event.isBusy,
      session?.is_busy,
      session?.isBusy,
    ),
    isTyping: pickBool(
      propertiesInfo?.is_typing,
      propertiesInfo?.isTyping,
      propertiesContext?.is_typing,
      propertiesContext?.isTyping,
      properties?.is_typing,
      properties?.isTyping,
      info?.is_typing,
      info?.isTyping,
      payloadInfo?.is_typing,
      payloadInfo?.isTyping,
      payload?.is_typing,
      payload?.isTyping,
      dataInfo?.is_typing,
      dataInfo?.isTyping,
      data?.is_typing,
      data?.isTyping,
      metadataInfo?.is_typing,
      metadataInfo?.isTyping,
      metadata?.is_typing,
      metadata?.isTyping,
      context?.is_typing,
      context?.isTyping,
      event.is_typing,
      event.isTyping,
      session?.is_typing,
      session?.isTyping,
    ),
  }
}

const getTty = async () => {
  try {
    const { stdout } = await execFileAsync('tty', [])
    const tty = stdout.trim()
    return tty === 'not a tty' ? '' : tty
  } catch {
    return ''
  }
}

const normalizeTmuxValue = (value: string) => {
  const trimmed = value.trim()
  return !trimmed || trimmed === '-' ? '' : trimmed
}

const parseOptionalInt = (value: string) => {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? null : parsed
}

const getTmuxSocketPath = () => {
  const raw = (process.env.TMUX || '').trim()
  if (!raw) return ''
  const [socketPath] = raw.split(',', 1)
  return socketPath?.trim() || ''
}

const pushTmuxLayerValue = (
  layer: Record<string, unknown>,
  key: string,
  value: string | null | undefined,
) => {
  const trimmed = normalizeTmuxValue(value || '')
  if (trimmed) {
    layer[key] = trimmed
  }
}

type TmuxSnapshot = {
  sessionName: string
  paneId: string
  windowId: string
  windowName: string
  windowIndex: string
  paneIndex: string
  clientPid: string
  clientTty: string
  socket: string
}

const isSafeSshTtyPath = (value: string) => /^\/dev\/(tty|pts\/)/.test(value)

const normalizeSshSessionEnv = (
  data: Record<string, unknown>,
  ttyHint?: string,
): SshSessionEnv | null => {
  const sshTty = typeof data.ssh_tty === 'string' ? normalizeTmuxValue(data.ssh_tty) : ''
  if (!sshTty || !isSafeSshTtyPath(sshTty)) return null
  if (ttyHint && sshTty !== ttyHint) return null

  return {
    ssh_forward_tty: sshTty,
    ssh_forward_snapshot: data,
    ssh_tty: sshTty,
    ssh_connection:
      typeof data.ssh_connection === 'string' ? normalizeTmuxValue(data.ssh_connection) : undefined,
    ssh_auth_sock:
      typeof data.ssh_auth_sock === 'string' ? normalizeTmuxValue(data.ssh_auth_sock) : undefined,
    b2v_ssh_tunnel_id:
      typeof data.b2v_ssh_tunnel_id === 'string'
        ? normalizeTmuxValue(data.b2v_ssh_tunnel_id)
        : undefined,
    b2v_ssh_target:
      typeof data.b2v_ssh_target === 'string' ? normalizeTmuxValue(data.b2v_ssh_target) : undefined,
    b2v_host_tmux_pane_id:
      typeof data.b2v_host_tmux_pane_id === 'string'
        ? normalizeTmuxValue(data.b2v_host_tmux_pane_id)
        : undefined,
  }
}

const readSshForwardTtyEnv = async (): Promise<Record<string, unknown> | null> => {
  try {
    const content = await fs.readFile(path.join(getConfigDir(), 'ssh-forward.json'), 'utf8')
    const root = JSON.parse(content) as Record<string, unknown>
    const ttyEnv = root.tty_env
    if (!ttyEnv || typeof ttyEnv !== 'object' || Array.isArray(ttyEnv)) {
      return null
    }
    return ttyEnv as Record<string, unknown>
  } catch {
    return null
  }
}

const pushSshTtyCandidate = (candidates: string[], raw: string | null | undefined) => {
  const tty = normalizeTmuxValue(raw || '')
  if (tty && isSafeSshTtyPath(tty) && !candidates.includes(tty)) {
    candidates.push(tty)
  }
}

const resolveCurrentSshTtyCandidates = async () => {
  // Resolve the SSH client TTY used to key ssh-forward.json. In remote tmux,
  // `tty` names the pane PTY, while #{client_tty} names the attached SSH client.
  // Prefer tmux client_tty whenever tmux is active, then keep tty/SSH_TTY fallbacks.
  const candidates: string[] = []

  if (process.env.TMUX) {
    try {
      const stdout = await execTmuxDisplayMessage(['display-message', '-p', '#{client_tty}'])
      pushSshTtyCandidate(candidates, stdout)
    } catch {
      // Ignore tmux client TTY lookup failures.
    }
  }

  pushSshTtyCandidate(candidates, await getTty())
  pushSshTtyCandidate(candidates, process.env.SSH_TTY)

  return candidates
}

const hasSshRoutingMetadata = (
  session: SshSessionEnv | null | undefined,
): session is SshSessionEnv =>
  !!normalizeTmuxValue(session?.b2v_ssh_tunnel_id || '') ||
  !!normalizeTmuxValue(session?.b2v_ssh_target || '')

const resolveSshEnvForCurrentTty = async (): Promise<SshSessionEnv | null> => {
  const ttyCandidates = await resolveCurrentSshTtyCandidates()
  const ttyEnv = await readSshForwardTtyEnv()

  if (!ttyEnv) {
    return null
  }

  for (const currentTty of ttyCandidates) {
    const directEntry = ttyEnv[currentTty]
    const directMatch =
      directEntry && typeof directEntry === 'object' && !Array.isArray(directEntry)
        ? normalizeSshSessionEnv(directEntry as Record<string, unknown>, currentTty)
        : null
    if (hasSshRoutingMetadata(directMatch)) {
      return directMatch
    }
  }

  const sessions: SshSessionEnv[] = []

  for (const entry of Object.values(ttyEnv)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const session = normalizeSshSessionEnv(entry as Record<string, unknown>)
    if (hasSshRoutingMetadata(session)) sessions.push(session)
  }

  return sessions.length === 1 ? sessions[0] : null
}

const buildTmuxChain = (tmux: TmuxSnapshot | null, sshSession: SshSessionEnv | null) => {
  const chain: Record<string, unknown>[] = []

  if (tmux) {
    const remoteLayer: Record<string, unknown> = {
      source: (sshSession?.ssh_connection || '').trim() ? 'ssh_remote' : 'local_host',
    }
    pushTmuxLayerValue(remoteLayer, 'session_name', tmux.sessionName)
    pushTmuxLayerValue(remoteLayer, 'pane_id', tmux.paneId)
    pushTmuxLayerValue(remoteLayer, 'window_id', tmux.windowId)

    const parsedWindowIndex = parseOptionalInt(tmux.windowIndex)
    if (parsedWindowIndex !== null) {
      remoteLayer.window_index = parsedWindowIndex
    }

    const parsedPaneIndex = parseOptionalInt(tmux.paneIndex)
    if (parsedPaneIndex !== null) {
      remoteLayer.pane_index = parsedPaneIndex
    }

    const parsedClientPid = parseOptionalInt(tmux.clientPid)
    if (parsedClientPid !== null) {
      remoteLayer.client_pid = parsedClientPid
    }

    pushTmuxLayerValue(remoteLayer, 'client_tty', tmux.clientTty)
    pushTmuxLayerValue(remoteLayer, 'socket', tmux.socket)
    chain.push(remoteLayer)
  }

  return chain.length > 0 ? chain : undefined
}

const applyTmuxChainContext = (
  params: Record<string, unknown>,
  tmux: TmuxSnapshot | null,
  sshSession: SshSessionEnv | null,
) => {
  const chain = buildTmuxChain(tmux, sshSession)
  if (chain) {
    params.tmux_chain = chain
  }
}

interface SshSessionEnv {
  ssh_forward_tty?: string
  ssh_forward_snapshot?: Record<string, unknown>
  ssh_tty?: string
  ssh_connection?: string
  ssh_auth_sock?: string
  b2v_ssh_tunnel_id?: string
  b2v_ssh_target?: string
  b2v_host_tmux_pane_id?: string
}

const applySshContext = (params: Record<string, unknown>, session: SshSessionEnv | null) => {
  if (!session) return

  if (session.ssh_forward_tty) params.ssh_forward_tty = session.ssh_forward_tty
  if (session.ssh_forward_snapshot) params.ssh_forward_snapshot = session.ssh_forward_snapshot
  if (session.ssh_connection) params.ssh_connection = session.ssh_connection
  if (session.ssh_tty) params.ssh_tty = session.ssh_tty
  if (session.b2v_ssh_tunnel_id) params.ssh_tunnel_id = session.b2v_ssh_tunnel_id
  if (session.b2v_ssh_target) params.ssh_target = session.b2v_ssh_target
}

const getTmuxInfo = async (): Promise<TmuxSnapshot | null> => {
  if (!process.env.TMUX) {
    // await logLine('getTmuxInfo: TMUX env missing')
    return null
  }

  const targetPane = process.env.TMUX_PANE
  if (!targetPane) {
    // await logLine('getTmuxInfo: TMUX_PANE missing')
    return null
  }

  try {
    const [
      sessionName,
      paneId,
      windowId,
      windowName,
      windowIndex,
      paneIndex,
      clientPid,
      clientTty,
    ] = await Promise.all([
      execTmuxDisplayMessage(['display-message', '-p', '-t', targetPane, '#{session_name}']),
      execTmuxDisplayMessage(['display-message', '-p', '-t', targetPane, '#{pane_id}']),
      execTmuxDisplayMessage(['display-message', '-p', '-t', targetPane, '#{window_id}']),
      execTmuxDisplayMessage(['display-message', '-p', '-t', targetPane, '#{window_name}']),
      execTmuxDisplayMessage(['display-message', '-p', '-t', targetPane, '#{window_index}']),
      execTmuxDisplayMessage(['display-message', '-p', '-t', targetPane, '#{pane_index}']),
      execTmuxDisplayMessage(['display-message', '-p', '-t', targetPane, '#{client_pid}']),
      execTmuxDisplayMessage(['display-message', '-p', '-t', targetPane, '#{client_tty}']),
    ])

    const name = normalizeTmuxValue(sessionName)
    if (!name) return null

    return {
      sessionName: name,
      paneId: normalizeTmuxValue(paneId),
      windowId: normalizeTmuxValue(windowId),
      windowName: normalizeTmuxValue(windowName),
      windowIndex: normalizeTmuxValue(windowIndex),
      paneIndex: normalizeTmuxValue(paneIndex),
      clientPid: normalizeTmuxValue(clientPid),
      clientTty: normalizeTmuxValue(clientTty),
      socket: normalizeTmuxValue(getTmuxSocketPath()),
    }
  } catch (error) {
    await logLine(`tmux info failed: ${String(error)}`)
    return null
  }
}

const generateSessionHash = () => {
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 900000 + 100000)
  return `B2V_${random}_${timestamp}`
}

const getWrapperSessionHashFromEnv = () => pickString(process.env.B2V_SESSION_HASH)

const getOpencodeSessionHintFilePath = () => pickString(process.env.B2V_OPENCODE_SESSION_HINT_FILE)

const writeOpencodeSessionHint = async (sessionHash: string) => {
  if (!sessionHash) return

  const hintFilePath = getOpencodeSessionHintFilePath()
  if (!hintFilePath) return

  try {
    await fs.mkdir(path.dirname(hintFilePath), { recursive: true })
    await fs.writeFile(hintFilePath, `${sessionHash}\n`, 'utf8')
    await logDebugLine(`Wrote opencode handoff session hash: ${sessionHash}`)
  } catch (error) {
    await logLine(`Failed to write opencode handoff file: ${String(error)}`)
  }
}

const readOpencodeSessionHint = async () => {
  const hintFilePath = getOpencodeSessionHintFilePath()
  if (!hintFilePath) return undefined

  try {
    const contents = await fs.readFile(hintFilePath, 'utf8')
    return pickString(contents.trim())
  } catch {
    return undefined
  }
}

let firstEventHandled = false
let sdkPromptClientPromise: Promise<PermissionReplyClient | null> | null = null
let promptClientPromise: Promise<PermissionReplyClient | null> | null = null
const inFlightPromptRequests = new Map<string, Promise<void>>()
const registeredSessionHashes = new Set<string>()

export const Back2VibingPlugin: Plugin = async ({
  directory,
  client,
  serverUrl,
}: {
  directory: string
  client?: PermissionReplyClient
  serverUrl?: URL
}) => {
  if (isB2vDisabled()) {
    // Plugin disabled, return no-op handler
    return {
      event: async () => {
        // intentional no-op
      },
    }
  }

  // Plugin load sentinel — not gated by DEBUG_EVENTS
  void logLine(
    `plugin loaded directory=${sanitizeLogValue(directory)} serverUrl=${sanitizeLogValue(serverUrl?.origin || '<none>')}`,
  )
  const promptRequestFetch = getProvidedPromptRequestFetch(client)

  const resolvePromptClient = async () => {
    const providedCapabilities = getPromptClientCapabilities(client)
    if (hasAnyPromptClientCapability(providedCapabilities)) {
      await logPromptClientSurface('provided-client', client ?? null)
      return client ?? null
    }
    if (promptRequestFetch) {
      await logLine('prompt client: using provided _client transport fetch')
      return null
    }

    await logPromptClientSurface('provided-client-missing-capabilities', client ?? null)

    const adaptedProvidedClient = await adaptProvidedPromptClient(client ?? null)
    if (adaptedProvidedClient) {
      return adaptedProvidedClient
    }

    if (!sdkPromptClientPromise) {
      sdkPromptClientPromise = createSdkPromptClient(directory, serverUrl)
    }

    return sdkPromptClientPromise
  }

  const getPromptClient = () => {
    if (!promptClientPromise) {
      promptClientPromise = resolvePromptClient()
    }

    return promptClientPromise
  }

  const ensureSessionRegistered = async (
    sessionHash: string | undefined,
    event: Record<string, unknown>,
    context: {
      cwd: string
      eventType: string
      parentId?: string
      parentSessionHash?: string
      setBusyAfterRegister?: boolean
    },
  ) => {
    if (!sessionHash) return false
    if (registeredSessionHashes.has(sessionHash)) return true

    await writeOpencodeSessionHint(sessionHash)

    const handled = await dispatchAgentEvent(
      directory,
      'session.created',
      eventWithSessionId(event, sessionHash),
    )
    if (handled) {
      registeredSessionHashes.add(sessionHash)
      return true
    }

    await logLine(`Registering session from ${context.eventType} fallback... Hash: ${sessionHash}`)
    const tmux = await getTmuxInfo()
    const sshSession = await resolveSshEnvForCurrentTty()
    const trustEnvTerminalIdentity = shouldTrustEnvTerminalIdentity(tmux, sshSession)
    const expectedBundleId = trustEnvTerminalIdentity ? resolveExpectedBundleIdHint() : undefined
    if (expectedBundleId) {
      await logLine(`Expected bundle hint resolved from env: ${expectedBundleId}`)
    } else if (isInsideTmux(tmux) && resolveExpectedBundleIdHint()) {
      await logLine('Expected bundle hint omitted: local tmux env identity is not authoritative')
    }

    const focusedParams: Record<string, unknown> = {
      agent_id: AGENT_ID,
    }
    if (expectedBundleId) {
      focusedParams.expected_bundle_id = expectedBundleId
    }

    const focused = await ipcRequest('get_focused_app', focusedParams)
    if (!focused.ok || !focused.response) return false

    try {
      const app = JSON.parse(focused.response).result

      void ipcRequest('init_overlay', {
        message: 'Registering session...',
        source: 'ts-hook',
        session_hash: sessionHash,
      })

      const bundleId = resolveFocusedBundleId(app, { trustEnv: trustEnvTerminalIdentity })
      const registrationBundleId = bundleId || AGENT_ID
      const registrationAppName = pickString(app.app_name) || (bundleId ? bundleId : 'OpenCode')
      const params: Record<string, unknown> = {
        session_hash: sessionHash,
        agent_id: AGENT_ID,
        bundle_id: registrationBundleId,
        app_name: registrationAppName,
        pid: app.pid,
        window_id: app.window_id,
        window_title: app.window_title,
        cwd: context.cwd,
      }
      if (context.parentSessionHash) params.parent_session_hash = context.parentSessionHash
      if (context.parentId) params.parent_id = context.parentId
      if (expectedBundleId) params.expected_bundle_id = expectedBundleId

      const terminalTabId = trustEnvTerminalIdentity ? getTerminalTabIdFromEnv() : ''
      if (terminalTabId) params.terminal_tab_id = terminalTabId

      const tty = await getTty()
      if (tty) params.tty = tty

      applySshContext(params, sshSession)

      if (tmux) {
        await logLine(`Tmux info found: ${JSON.stringify(tmux)}`)
        params.tmux_session_name = tmux.sessionName
        params.tmux_pane_id = tmux.paneId
        params.tmux_window_id = tmux.windowId
        params.tmux_window_index = parseOptionalInt(tmux.windowIndex) ?? 0
        params.tmux_pane_index = parseOptionalInt(tmux.paneIndex) ?? 0
        params.tmux_client_pid = parseOptionalInt(tmux.clientPid)
      } else {
        await logLine('Tmux info NOT found')
      }
      applyTmuxChainContext(params, tmux, sshSession)
      params.runtime_terminal_input = buildRuntimeTerminalInput(tmux, sshSession)

      const registerResult = await ipcRequest('register_session_from_cli', params)
      if (!registerResult.ok) return false

      registeredSessionHashes.add(sessionHash)

      if (context.setBusyAfterRegister) {
        await setSessionStatus(sessionHash, 'busy', {
          agentId: AGENT_ID,
          cwd: context.cwd,
          bundleId,
          requestId: extractPromptRequestId(event),
          parentId: context.parentId,
          parentSessionHash: context.parentSessionHash,
          terminalTabId: terminalTabId || undefined,
          tmux,
        })
      }

      return true
    } catch (error) {
      await logLine(`Session registration fallback error: ${String(error)}`)
      return false
    }
  }

  const handlePromptInterceptAsync = async (
    eventType: string,
    event: Record<string, unknown>,
    requestID: string,
    interceptTrace: PromptInterceptTrace,
    providedClientCapabilities: PromptClientCapabilities,
  ) => {
    const effectiveServerUrl =
      serverUrl ??
      new URL(
        extractOpencodeServerUrl(event).serverUrl ??
          process.env.OPENCODE_URL ??
          'http://127.0.0.1:4096',
      )
    const promptClient = await getPromptClient()
    const effectiveClientCapabilities = getPromptClientCapabilities(promptClient)

    await logLine(
      `prompt intercept async start: intercept_id=${interceptTrace.intercept_id} type=${eventType} request_id=${requestID || '<missing>'} provided_permission_reply=${providedClientCapabilities.permissionReply} provided_question_reply=${providedClientCapabilities.questionReply} provided_question_reject=${providedClientCapabilities.questionReject} effective_permission_reply=${effectiveClientCapabilities.permissionReply} effective_question_reply=${effectiveClientCapabilities.questionReply} effective_question_reject=${effectiveClientCapabilities.questionReject} in_flight=${inFlightPromptRequests.size} server_url=${effectiveServerUrl.toString()}`,
    )

    try {
      if (eventType === 'permission.asked') {
        const result = await runAgentEventForPrompt(directory, eventType, event, {
          exec_id: nextPromptExecId(),
          intercept_id: interceptTrace.intercept_id,
          request_id: requestID,
        })
        await logLine(
          `prompt intercept result: intercept_id=${interceptTrace.intercept_id} type=${eventType} request_id=${requestID || '<missing>'} result_kind=${result?.kind || '<none>'}`,
        )
        if (result?.kind === 'native_prompt_pass_through') {
          await completePromptIntercept(interceptTrace, 'native_prompt_pass_through')
          return
        }
        if (result?.kind === 'permission') {
          const replyRequestID = await resolvePromptReplyRequestID(
            'permission',
            requestID,
            result.request_id,
          )
          if (!replyRequestID) {
            await completePromptIntercept(interceptTrace, 'request_id_mismatch', {
              result_request_id: result.request_id,
            })
            return
          }
          let delivered = false
          if (promptClient?.permission?.reply) {
            try {
              await logPromptClientSurface('selected-permission-client', promptClient)
              const replyResult = await promptClient.permission.reply({
                id: replyRequestID,
                requestID: replyRequestID,
                request_id: replyRequestID,
                requestId: replyRequestID,
                reply: result.reply,
                directory,
              })
              const replySummary = await logReplyResultDetails(
                'permission',
                replyRequestID,
                replyResult,
              )
              delivered = !replySummary.hasError && replySummary.ok !== false
            } catch (error) {
              await logLine(
                `agent-event permission SDK reply threw; trying direct HTTP: request_id=${replyRequestID} error=${summarizeProcessError(error)}`,
              )
            }
          }
          if (!delivered) {
            await sendPromptReplyDirect(
              effectiveServerUrl,
              directory,
              `/permission/${encodeURIComponent(replyRequestID)}/reply`,
              { reply: result.reply },
              promptRequestFetch ?? undefined,
            )
            delivered = true
          }
          if (!delivered) {
            await logLine(
              `agent-event permission reply failed: request_id=${replyRequestID} reply=${result.reply}`,
            )
          } else {
            await logLine(
              `agent-event permission replied: request_id=${replyRequestID} reply=${result.reply}`,
            )
          }
          await completePromptIntercept(interceptTrace, 'permission_replied', {
            reply_request_id: replyRequestID,
          })
        } else if (promptClient?.permission?.reply && requestID) {
          await logPromptClientSurface('selected-permission-client-fallback', promptClient)
          await logLine(
            `agent-event permission missing structured result; continuing with native prompt flow request_id=${requestID}`,
          )
          await completePromptIntercept(interceptTrace, 'native_prompt_pass_through', {
            reply_request_id: requestID,
          })
        } else {
          await logLine(
            `agent-event permission fell back to fire-and-forget dispatch: request_id=${requestID || '<missing>'}`,
          )
          await dispatchAgentEvent(directory, eventType, event)
          await completePromptIntercept(interceptTrace, 'permission_fire_and_forget')
        }

        return
      }

      const result = await runAgentEventForPrompt(directory, eventType, event, {
        exec_id: nextPromptExecId(),
        intercept_id: interceptTrace.intercept_id,
        request_id: requestID,
      })
      await logLine(
        `prompt intercept result: intercept_id=${interceptTrace.intercept_id} type=${eventType} request_id=${requestID || '<missing>'} result_kind=${result?.kind || '<none>'}`,
      )
      if (result?.kind === 'native_prompt_pass_through') {
        await completePromptIntercept(interceptTrace, 'native_prompt_pass_through')
        return
      }
      if (result?.kind === 'question') {
        if (result.rejected) {
          const rejectRequestID = await resolvePromptReplyRequestID(
            'question',
            requestID,
            result.request_id,
          )
          if (!rejectRequestID) {
            await completePromptIntercept(interceptTrace, 'request_id_mismatch', {
              result_request_id: result.request_id,
            })
            return
          }
          let delivered = false
          if (promptClient?.question?.reject) {
            try {
              const rejectResult = await promptClient.question.reject({
                id: rejectRequestID,
                requestID: rejectRequestID,
                request_id: rejectRequestID,
                requestId: rejectRequestID,
                directory,
              })
              const summary = await logReplyResultDetails('question', rejectRequestID, rejectResult)
              delivered = !summary.hasError && summary.ok !== false
            } catch (error) {
              await logLine(
                `agent-event question reject SDK threw: ${summarizeProcessError(error)}`,
              )
            }
          }
          if (!delivered) {
            await sendPromptReplyDirect(
              effectiveServerUrl,
              directory,
              `/question/${encodeURIComponent(rejectRequestID)}/reject`,
              undefined,
              promptRequestFetch ?? undefined,
            )
          }
          await completePromptIntercept(interceptTrace, 'question_rejected', {
            reply_request_id: rejectRequestID,
          })
        } else if (result.answers) {
          const replyRequestID = await resolvePromptReplyRequestID(
            'question',
            requestID,
            result.request_id,
          )
          if (!replyRequestID) {
            await completePromptIntercept(interceptTrace, 'request_id_mismatch', {
              result_request_id: result.request_id,
            })
            return
          }
          let delivered = false
          if (promptClient?.question?.reply) {
            try {
              const replyResult = await promptClient.question.reply({
                id: replyRequestID,
                requestID: replyRequestID,
                request_id: replyRequestID,
                requestId: replyRequestID,
                answers: result.answers,
                directory,
              })
              const summary = await logReplyResultDetails('question', replyRequestID, replyResult)
              delivered = !summary.hasError && summary.ok !== false
            } catch (error) {
              await logLine(`agent-event question reply SDK threw: ${summarizeProcessError(error)}`)
            }
          }
          if (!delivered) {
            await sendPromptReplyDirect(
              effectiveServerUrl,
              directory,
              `/question/${encodeURIComponent(replyRequestID)}/reply`,
              { answers: result.answers },
              promptRequestFetch ?? undefined,
            )
          }
          await completePromptIntercept(interceptTrace, 'question_replied', {
            reply_request_id: replyRequestID,
          })
        } else if (promptClient?.question?.reject) {
          const rejectRequestID = await resolvePromptReplyRequestID(
            'question',
            requestID,
            result.request_id,
          )
          if (!rejectRequestID) {
            await completePromptIntercept(interceptTrace, 'request_id_mismatch', {
              result_request_id: result.request_id,
            })
            return
          }
          await logPromptClientSurface('selected-question-client-fallback', promptClient)
          await logLine(
            `agent-event question missing structured answers; continuing with native prompt flow request_id=${rejectRequestID}`,
          )
          await completePromptIntercept(interceptTrace, 'native_prompt_pass_through', {
            reply_request_id: rejectRequestID,
          })
        } else {
          throw new Error(`OpenCode question reply API unavailable for ${result.request_id}`)
        }
      } else if (promptClient?.question?.reject && requestID) {
        await logPromptClientSurface('selected-question-client-missing-result', promptClient)
        await logLine(
          `agent-event question missing result; continuing with native prompt flow request_id=${requestID}`,
        )
        await completePromptIntercept(interceptTrace, 'native_prompt_pass_through', {
          reply_request_id: requestID,
        })
      } else if (!requestID) {
        await logLine(
          'agent-event question missing request_id and reply client; continuing without prompt reply',
        )
        await completePromptIntercept(interceptTrace, 'question_missing_request_id')
      } else {
        throw new Error(`OpenCode question fallback unavailable for ${requestID || '<missing>'}`)
      }
    } catch (error) {
      await completePromptIntercept(interceptTrace, 'error', {
        error: summarizeProcessError(error),
      })
      throw error
    }
  }

  const schedulePromptIntercept = async (eventType: string, event: Record<string, unknown>) => {
    const requestID = extractPromptRequestId(event, { includeGenericIds: true })

    if (requestID && inFlightPromptRequests.has(requestID)) {
      await logLine(
        `prompt intercept deduped: type=${eventType} request_id=${requestID} in_flight=${inFlightPromptRequests.size}`,
      )
      await inFlightPromptRequests.get(requestID)
      return
    }

    const providedClientCapabilities = getPromptClientCapabilities(client)
    const interceptTrace = await registerPromptIntercept(eventType, event)

    await logLine(
      `prompt intercept scheduled: intercept_id=${interceptTrace.intercept_id} type=${eventType} request_id=${requestID || '<missing>'} provided_permission_reply=${providedClientCapabilities.permissionReply} provided_question_reply=${providedClientCapabilities.questionReply} provided_question_reject=${providedClientCapabilities.questionReject} in_flight=${inFlightPromptRequests.size} server_url=${serverUrl?.toString() || '<missing>'}`,
    )

    const task = handlePromptInterceptAsync(
      eventType,
      event,
      requestID,
      interceptTrace,
      providedClientCapabilities,
    )
      .catch(async (error) => {
        await logLine(
          `prompt intercept background failure: intercept_id=${interceptTrace.intercept_id} type=${eventType} request_id=${requestID || '<missing>'} error=${summarizeProcessError(error)}`,
        )
      })
      .finally(() => {
        if (requestID) {
          inFlightPromptRequests.delete(requestID)
        }
      })

    if (requestID) {
      inFlightPromptRequests.set(requestID, task)
    }

    await task
  }

  const reportPromptWaitingStatus = async (
    eventType: string,
    event: Record<string, unknown>,
    context: {
      sessionHash?: string
      cwd: string
      parentId?: string
      parentSessionHash?: string
    },
  ) => {
    if (!context.sessionHash) return

    await ensureSessionRegistered(context.sessionHash, event, {
      cwd: context.cwd,
      eventType,
      parentId: context.parentId,
      parentSessionHash: context.parentSessionHash,
    })

    const bundleId = resolveFocusedBundleId(undefined)
    const tmux = await getTmuxInfo()
    await setSessionStatus(context.sessionHash, 'waiting', {
      agentId: AGENT_ID,
      cwd: context.cwd,
      bundleId,
      requestId: extractPromptRequestId(event, { includeGenericIds: true }),
      parentId: context.parentId,
      parentSessionHash: context.parentSessionHash,
      terminalTabId: getTerminalTabIdFromEnv() || undefined,
      tmux,
    })
  }

  return {
    event: async ({ event }) => {
      if (isB2vDisabled()) return

      const eventType = event.type
      if (!eventType) return

      const wrapperMode = process.env.B2V_SSH_WRAPPER === '1'
      let sessionHash = extractSessionId(event)
      if (!sessionHash && SESSION_END_EVENT_TYPES.has(eventType)) {
        sessionHash = getWrapperSessionHashFromEnv() || (await readOpencodeSessionHint())
      }
      const parentId = extractParentMarker(event) || undefined
      const parentSessionHash = extractParentSessionHash(event) || undefined
      const cwd = extractCwd(event, directory)

      const lifecycleSignal = getLifecycleSignal(eventType, event)
      const statusType = getSessionStatusType(event)
      const isPromptInterceptEvent = INTERACTION_EVENT_NOTIFICATION_TYPES.has(eventType)
      const skipSubagentHookEvent = shouldSkipSubagentHooks(eventType, event, sessionHash)
      let promptInterceptScheduled = false

      // First-event sentinel — not gated by DEBUG_EVENTS
      if (!firstEventHandled) {
        firstEventHandled = true
        void logLine(
          `first event: type=${sanitizeLogValue(eventType)} session=${sanitizeLogValue(sessionHash || '<none>')} directory=${sanitizeLogValue(directory)}`,
        )
      }

      // [event-in] audit log — fires for EVERY event so we can diagnose
      // missed idles, dropped status events, and misclassifications.
      // Surfaces raw signals the hook used to make its routing decision so
      // we can prove whether opencode sent the event vs. the hook dropped it.
      void logLine(
        `[event-in] type=${sanitizeLogValue(eventType)} session=${sanitizeLogValue(sessionHash || '<none>')} ` +
          `lifecycle=${lifecycleSignal || '<none>'} status=${sanitizeLogValue(statusType || '<none>')} ` +
          `subagent_skip=${skipSubagentHookEvent} parent=${sanitizeLogValue(parentSessionHash || '<none>')} ` +
          `prompt_intercept=${isPromptInterceptEvent}`,
      )

      if (DEBUG_EVENTS) {
        const summary = summarizeEvent(event, directory)
        const routing = summarizeEventRouting(eventType, event, sessionHash, cwd, wrapperMode)
        await logBlock('Event summary:', summary)
        await logBlock('Event routing:', routing)
        await logBlock('Event raw:', event)
      }

      if (skipSubagentHookEvent) {
        if (DEBUG_EVENTS) {
          await logLine(
            `Subagent lifecycle event: signal=${lifecycleSignal || '<none>'} session=${sessionHash || '<unknown>'}`,
          )
        }
        if (
          (parentSessionHash || parentId) &&
          (lifecycleSignal === 'busy' || lifecycleSignal === 'idle')
        ) {
          await setSessionStatus(sessionHash, lifecycleSignal, {
            agentId: AGENT_ID,
            cwd,
            requestId: extractPromptRequestId(event),
            parentId,
            parentSessionHash,
          })
        }
        if (SESSION_END_EVENT_TYPES.has(eventType)) {
          const params: Record<string, unknown> = { cwd }
          if (sessionHash) {
            params.session_hash = sessionHash
          }
          await ipcRequest('unregister_session', params)
        }
        return
      }

      if (shouldCoalesceFocusEvent(eventType, sessionHash, cwd, statusType)) {
        if (isPromptInterceptEvent && !promptInterceptScheduled) {
          await schedulePromptIntercept(eventType, event)
          promptInterceptScheduled = true
        }
        await logDebugLine(
          `Coalesced duplicate focus event: type=${eventType} session=${sessionHash || '<none>'} status=${statusType || '<none>'}`,
        )
        return
      }

      if (isFocusEventInFlight(eventType, sessionHash, cwd, statusType)) {
        if (isPromptInterceptEvent && !promptInterceptScheduled) {
          await schedulePromptIntercept(eventType, event)
          promptInterceptScheduled = true
        }
        await logDebugLine(
          `Coalesced in-flight focus event: type=${eventType} session=${sessionHash || '<none>'} status=${statusType || '<none>'}`,
        )
        await waitForInFlightFocusEvent(eventType, sessionHash, cwd, statusType)
        if (isFocusEventInFlight(eventType, sessionHash, cwd, statusType)) {
          return
        }
        if (shouldCoalesceFocusEvent(eventType, sessionHash, cwd, statusType)) {
          return
        }
      }

      const focusEventKey = getFocusEventKey(eventType, sessionHash, cwd, statusType)
      const clearInFlightFocusEvent = focusEventKey
        ? registerInFlightFocusEvent(focusEventKey)
        : null

      try {
        let handledEvent = false
        if (wrapperMode) {
          if (!sessionHash && SESSION_START_EVENT_TYPES.has(eventType)) {
            sessionHash = getWrapperSessionHashFromEnv() || generateSessionHash()
          }

          if (!sessionHash) {
            handledEvent = true
            await logLine(`Wrapper mode skip: missing session hash for ${eventType}`)
            return
          }

          const tmux = await getTmuxInfo()
          const sshSession = await resolveSshEnvForCurrentTty()
          const expectedBundleId = resolveExpectedBundleIdHint() || undefined
          const payload: Record<string, unknown> = {
            session_hash: sessionHash,
            agent_id: AGENT_ID,
            cwd,
            transport_snapshot_mode: 'full',
            context: {
              cwd,
              expected_bundle_id: expectedBundleId,
              terminal_tab_id: undefined as string | undefined,
              tmux_context: undefined as Record<string, unknown> | undefined,
              ssh_context: undefined as Record<string, unknown> | undefined,
            },
          }
          const terminalTabId = getTerminalTabIdFromEnv()
          if (terminalTabId) payload.terminal_tab_id = terminalTabId
          if (expectedBundleId) payload.expected_bundle_id = expectedBundleId
          const payloadContext = payload.context as Record<string, unknown>
          if (terminalTabId) payloadContext.terminal_tab_id = terminalTabId

          if (tmux) {
            payload.tmux_session_name = tmux.sessionName
            payload.tmux_pane_id = tmux.paneId
            payload.tmux_window_id = tmux.windowId
            payload.tmux_window_index = parseOptionalInt(tmux.windowIndex)
            payload.tmux_pane_index = parseOptionalInt(tmux.paneIndex)
            payloadContext.tmux_context = {
              session_name: tmux.sessionName,
              pane_id: tmux.paneId,
              window_id: tmux.windowId,
              window_index: parseOptionalInt(tmux.windowIndex),
              pane_index: parseOptionalInt(tmux.paneIndex),
            }
          }
          applySshContext(payload, sshSession)
          applyTmuxChainContext(payload, tmux, sshSession)
          if (sshSession) {
            payloadContext.ssh_context = {
              ssh_connection: sshSession.ssh_connection,
              ssh_tty: sshSession.ssh_tty,
              ssh_tunnel_id: sshSession.b2v_ssh_tunnel_id,
              ssh_target: sshSession.b2v_ssh_target,
              ssh_forward_tty: sshSession.ssh_forward_tty,
              forward_snapshot: sshSession.ssh_forward_snapshot,
            }
          }

          if (SESSION_START_EVENT_TYPES.has(eventType)) {
            handledEvent = true
            await emitWrapperEvent({ ...payload, event: 'session_start' })
            if (lifecycleSignal === 'busy') {
              await emitWrapperEvent({
                ...payload,
                event: 'activity',
                status: 'busy',
              })
            }
            return
          }

          if (lifecycleSignal === 'busy') {
            handledEvent = true
            await emitWrapperEvent({
              ...payload,
              event: 'activity',
              status: 'busy',
            })
            return
          }

          if (isFocusCandidateEvent(eventType, event) && !isPromptInterceptEvent) {
            handledEvent = true
            const typingSignals = extractTypingSignals(event)
            const notificationType = getInteractionPromptNotificationType(eventType, event)
            await emitWrapperEvent({
              ...payload,
              event: 'focus',
              status: lifecycleSignal,
              prompt_response: Boolean(notificationType),
              notification_type: notificationType,
              is_busy: typingSignals.isBusy,
              is_typing: typingSignals.isTyping,
            })
            markFocusEventHandled(eventType, sessionHash, cwd, statusType)
            return
          }

          if (SESSION_END_EVENT_TYPES.has(eventType)) {
            handledEvent = true
            await emitWrapperEvent({ ...payload, event: 'session_end' })
            return
          }
        }

        // 0. Agent-event intercept for permission/question prompts
        if (isPromptInterceptEvent && !promptInterceptScheduled) {
          await reportPromptWaitingStatus(eventType, event, {
            sessionHash,
            cwd,
            parentId,
            parentSessionHash,
          })
          await schedulePromptIntercept(eventType, event)
          promptInterceptScheduled = true
          // The prompt intercept owns OpenCode reply/pass-through handling.
          // The hook still reports waiting above because native pass-through
          // can return before the Rust agent-event route sees the prompt.
          // Do NOT fall through to the focus-candidate block below; that would
          // double-process focus delivery for the same prompt event.
          handledEvent = true
          return
        }

        // 0b. Auto-dismiss stale prompts when user handles them directly in terminal
        if (eventType === 'permission.replied' || eventType === 'question.replied') {
          const repliedRequestId = extractPromptRequestId(event, { includeGenericIds: true })
          if (repliedRequestId) {
            await logLine(`prompt auto-dismiss: type=${eventType} request_id=${repliedRequestId}`)
            void ipcRequest('cancel_prompt', {
              prompt_id: repliedRequestId,
            }).catch(async (error) => {
              await logLine(
                `prompt auto-dismiss failed: type=${eventType} request_id=${repliedRequestId} error=${String(error)}`,
              )
            })
          }
        }

        // 1. Focus Events
        const lifecycleRequestId = extractPromptRequestId(event)

        if (lifecycleSignal === 'busy' && !SESSION_START_EVENT_TYPES.has(eventType)) {
          if (
            eventType === 'session.status' &&
            isBusyForRecentIdleRequest(sessionHash, lifecycleRequestId)
          ) {
            handledEvent = true
            await logLine(
              `Skipping busy after same-request idle guard: type=${sanitizeLogValue(eventType)} session=${sanitizeLogValue(sessionHash)} request_id=${sanitizeLogValue(lifecycleRequestId || '<missing>')}`,
            )
            markFocusEventHandled(eventType, sessionHash, cwd, statusType)
            return
          }

          handledEvent = true
          await ensureSessionRegistered(sessionHash, event, {
            cwd,
            eventType,
            parentId,
            parentSessionHash,
          })
          const tmux = await getTmuxInfo()
          await setSessionStatus(sessionHash, 'busy', {
            agentId: AGENT_ID,
            cwd,
            bundleId: resolveFocusedBundleId(undefined),
            requestId: lifecycleRequestId,
            parentId,
            parentSessionHash,
            terminalTabId: getTerminalTabIdFromEnv() || undefined,
            tmux,
          })
          if (eventType === 'session.status' && sessionHash) {
            directBusyStatusBySession.add(sessionHash)
          }
          return
        }

        if (isFocusCandidateEvent(eventType, event)) {
          handledEvent = true
          const typingSignals = extractTypingSignals(event)
          const notificationType = getInteractionPromptNotificationType(eventType, event)
          const tmux = await getTmuxInfo()
          const terminalTabId = getTerminalTabIdFromEnv()
          const bundleId = resolveFocusedBundleId(undefined)

          if (lifecycleSignal) {
            const shouldUseWindowsAgentEvent =
              process.platform === 'win32' &&
              !process.env.VITEST &&
              (lifecycleSignal === 'idle' ||
                (lifecycleSignal === 'waiting' && !isPromptInterceptEvent))
            if (shouldUseWindowsAgentEvent) {
              const handled = await dispatchAgentEvent(
                directory,
                eventType,
                eventWithSessionId(event, sessionHash),
              )
              if (handled) {
                markFocusEventHandled(eventType, sessionHash, cwd, statusType)
                return
              }
            }

            if (lifecycleSignal === 'idle') {
              recordSessionIdleRequest(sessionHash, lifecycleRequestId)
            }
            if (!(eventType === 'session.status' && lifecycleSignal === 'waiting')) {
              await ensureSessionRegistered(sessionHash, event, {
                cwd,
                eventType,
                parentId,
                parentSessionHash,
              })
            }
            const explicitCompletion =
              lifecycleSignal === 'idle' &&
              (isExplicitCompletionEvent(eventType, event) ||
                (eventType === 'session.status' &&
                  statusType === 'idle' &&
                  (!sessionHash || !directBusyStatusBySession.has(sessionHash))))
            const statusResult = await setSessionStatus(sessionHash, lifecycleSignal, {
              agentId: AGENT_ID,
              cwd,
              bundleId,
              requestId: lifecycleRequestId,
              explicitCompletion,
              parentId,
              parentSessionHash,
              terminalTabId: terminalTabId || undefined,
              isTyping: typingSignals.isTyping,
              isBusy: typingSignals.isBusy,
              tmux,
            })

            if (lifecycleSignal === 'idle') {
              if (sessionHash) {
                directBusyStatusBySession.delete(sessionHash)
              }
            }

            if (lifecycleSignal === 'idle' && (statusResult.suppressed || statusResult.deduped)) {
              await logLine(
                `Skipping idle focus after backend status guard: type=${sanitizeLogValue(eventType)} session=${sanitizeLogValue(sessionHash)} request_id=${sanitizeLogValue(lifecycleRequestId || '<missing>')} suppressed=${statusResult.suppressed} deduped=${statusResult.deduped}`,
              )
              markFocusEventHandled(eventType, sessionHash, cwd, statusType)
              return
            }

            // Backend owns alert dispatch when lifecycle IPC succeeds. If that
            // single call fails, still try focus_by_session before local fallback.
            if (lifecycleSignal === 'idle' || lifecycleSignal === 'waiting') {
              if (statusResult.ipcOk) {
                await logDebugLine(
                  `Lifecycle status reported; backend owns alert dispatch: type=${sanitizeLogValue(eventType)} signal=${lifecycleSignal} session=${sanitizeLogValue(sessionHash)} request_id=${sanitizeLogValue(lifecycleRequestId || '<missing>')}`,
                )
                markFocusEventHandled(eventType, sessionHash, cwd, statusType)
                return
              }

              await logLine(
                `IPC set_session_status failed; trying focus_by_session before local fallback: type=${sanitizeLogValue(eventType)} signal=${lifecycleSignal}`,
              )
            }
          }

          if (isPromptInterceptEvent) {
            markFocusEventHandled(eventType, sessionHash, cwd, statusType)
            return
          }

          if (shouldSuppressFocusDelivery(eventType)) {
            markFocusEventHandled(eventType, sessionHash, cwd, statusType)
            return
          }

          const state = await getFocusState()
          if (!state.globalEnabled || !state.agentEnabled) return

          if (!sessionHash) {
            // If no session hash, fallback might be needed but ipc focus requires it?
            // Actually focus_by_session might fail without hash if it relies on exact match.
            // But let's proceed.
          }

          const licenseState = await checkLicenseState()
          if (licenseState !== 'non_pro') {
            if (licenseState === 'pro') {
              await logLine('💎 Pro Tier: Using IPC Focus')
            } else {
              await logLine('⚠️ License check failed: continuing with IPC Focus')
            }

            const params: Record<string, unknown> = {
              session_hash: sessionHash || '',
              agent_id: AGENT_ID,
              cwd,
              is_busy: typingSignals.isBusy,
              is_typing: typingSignals.isTyping,
            }
            if (notificationType) {
              params.prompt_response = true
              params.notification_type = notificationType
            }
            const tty = await getTty()
            if (tty) params.tty = tty

            const sshSession = await resolveSshEnvForCurrentTty()
            applySshContext(params, sshSession)

            const trustEnvTerminalIdentity = shouldTrustEnvTerminalIdentity(tmux, sshSession)
            if (trustEnvTerminalIdentity) {
              if (notificationType && bundleId) params.bundle_id = bundleId
              if (terminalTabId) params.terminal_tab_id = terminalTabId
            }

            if (tmux) {
              params.tmux_session_name = tmux.sessionName
              params.tmux_pane_id = tmux.paneId
              params.tmux_window_id = tmux.windowId
              params.tmux_window_index = parseOptionalInt(tmux.windowIndex) ?? 0
              params.tmux_pane_index = parseOptionalInt(tmux.paneIndex) ?? 0
              params.tmux_client_pid = parseOptionalInt(tmux.clientPid)
            }
            applyTmuxChainContext(params, tmux, sshSession)
            params.runtime_terminal_input = buildRuntimeTerminalInput(tmux, sshSession)

            const focusResult = await ipcRequest('focus_by_session', params)
            if (focusResult.ok && focusResult.response) {
              markFocusEventHandled(eventType, sessionHash, cwd, statusType)
            } else {
              await logLine('IPC focus_by_session failed, using local fallback')
              const fallbackHandled = await runLocalFallback(state.soundMuted)
              if (fallbackHandled) {
                markFocusEventHandled(eventType, sessionHash, cwd, statusType)
              }
            }
          } else {
            await logLine('📱 GUI Tier: Local Fallback')
            void ipcRequest('track_focus', {
              session_hash: sessionHash || '',
              agent_id: AGENT_ID,
              success: true,
            })
            await runLocalFallback(state.soundMuted)
            markFocusEventHandled(eventType, sessionHash, cwd, statusType)
          }
        }

        // 2. Session Start
        if (SESSION_START_EVENT_TYPES.has(eventType)) {
          handledEvent = true
          if ((await checkLicenseState()) === 'non_pro') return

          // Ensure session hash exists
          if (!sessionHash) {
            sessionHash = getWrapperSessionHashFromEnv() || generateSessionHash()
            await logLine(`Generated fallback session hash: ${sessionHash}`)
          }

          await ensureSessionRegistered(sessionHash, event, {
            cwd,
            eventType,
            parentId,
            parentSessionHash,
            setBusyAfterRegister: true,
          })
        }

        // 3. Session End
        if (SESSION_END_EVENT_TYPES.has(eventType)) {
          handledEvent = true
          // Try dispatching via agent-event CLI first (preferred)
          const handled = await dispatchAgentEvent(
            directory,
            eventType,
            eventWithSessionId(event, sessionHash),
          )
          if (handled) return

          // doesn't work right now because these events are not fired by opencode yet
          const tmux = await getTmuxInfo()
          const params: Record<string, unknown> = { cwd }

          if (sessionHash) {
            params.session_hash = sessionHash
          }

          if (tmux) {
            params.tmux_pane_id = tmux.paneId
            params.tmux_session_name = tmux.sessionName
            params.tmux_window_id = tmux.windowId
            params.tmux_window_index = parseOptionalInt(tmux.windowIndex)
            params.tmux_pane_index = parseOptionalInt(tmux.paneIndex)
          }
          const sshSession = await resolveSshEnvForCurrentTty()
          applySshContext(params, sshSession)
          applyTmuxChainContext(params, tmux, sshSession)

          if (!sessionHash && !tmux) {
            await logLine('⚠️ server.instance.disposed: No identifying info (sessionHash or tmux)')
          }

          await ipcRequest('unregister_session', params)
        }

        if (!handledEvent && DEBUG_EVENTS) {
          await logDebugLine(
            `Event handled: no matching hook action for type=${eventType} session=${sessionHash || '<none>'}`,
          )
        }
      } finally {
        clearInFlightFocusEvent?.()
      }
    },
  }
}

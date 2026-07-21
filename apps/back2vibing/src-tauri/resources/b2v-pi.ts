import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const AGENT_ID = '__B2V_PI_AGENT_ID__'
const AGENT_EVENT_SCRIPT = '__B2V_AGENT_EVENT_SCRIPT_PATH__'
const AGENT_EVENT_TIMEOUT_MS = 5000
const GATE_MODE = '__B2V_PI_GATE_MODE__'
const GATE_TIMEOUT_MS = 600_000
const PI_ASK_REPLY_CONTRACT = 'pi-ask-v1'
const PI_ASK_TIMEOUT_MS = 540_000
const READ_TOOLS: Record<string, true> = {
  read: true,
  grep: true,
  glob: true,
  ls: true,
  list: true,
  tree: true,
  fetch: true,
  web_search: true,
  websearch: true,
  ask: true,
  todo: true,
  task_status: true,
}
const WRITE_TOOLS: Record<string, true> = {
  write: true,
  edit: true,
  multi_edit: true,
  apply_patch: true,
  patch: true,
  notebook_edit: true,
}
const sessionAllowed = new Set<string>()
let fallbackSessionHash: string | undefined

const isBack2VibingDisabled = () => process.env.B2V_DISABLED === 'true'

const expectedBundleId = () => {
  const bundleId = process.env.__CFBundleIdentifier?.trim()
  return bundleId ? bundleId : undefined
}

const explicitChildSessionParent = () => {
  if (process.env.B2V_CHILD_SESSION !== 'true') return undefined

  const parent = process.env.B2V_PARENT_SESSION_HASH?.trim()
  return parent || undefined
}

type PiSessionEvent = {
  reason?: string
  previousSessionFile?: string
}

type PiAgentEvent = {
  prompt?: string
}

type PiAgentEndEvent = {
  readonly willContinue?: boolean
  readonly [key: string]: unknown
}

type PiTurnEvent = {
  turnIndex: number
  timestamp: number
}

type PiToolApprovalRequestedEvent = {
  sessionId?: string
  toolCallId: string
  toolName: string
  reason?: string
  approvalMode?: string
}

type PiToolCallEvent = {
  toolCallId: string
  toolName: string
  input?: Record<string, unknown>
}
type ToolGateResult = { block: true; reason: string } | undefined

type PiAskOption = {
  readonly label: string
  readonly description?: string
  readonly preview?: string
}

type PiAskQuestion = {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly options: readonly PiAskOption[]
  readonly multi?: boolean
  readonly recommended?: number
}

type PiAskAnswer = {
  readonly id: string
  readonly selectedOptions: readonly string[]
  readonly customInput?: string
  readonly note?: string
  readonly timedOut?: boolean
}

type PiAskDialogResult =
  | { readonly kind: 'chat' }
  | {
      readonly kind: 'submit'
      readonly results: readonly PiAskAnswer[]
    }

type PiAskContext = ExtensionContext & {
  readonly abort: () => void
  readonly ui: {
    readonly askDialog?: (
      questions: readonly PiAskQuestion[],
      options?: { readonly signal?: AbortSignal },
    ) => Promise<PiAskDialogResult | undefined>
  }
}

type PiAskDetails = {
  readonly question?: string
  readonly options?: readonly string[]
  readonly multi?: boolean
  readonly selectedOptions?: readonly string[]
  readonly customInput?: string
  readonly note?: string
  readonly timedOut?: boolean
  readonly results?: readonly {
    readonly id: string
    readonly question: string
    readonly options: readonly string[]
    readonly multi: boolean
    readonly selectedOptions: readonly string[]
    readonly customInput?: string
    readonly note?: string
    readonly timedOut?: boolean
  }[]
  readonly chatRedirect?: boolean
  readonly questions?: readonly string[]
}

type PiAskToolResult = {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly details: PiAskDetails
}

export type PiAskToolDefinition = {
  readonly name: 'ask'
  readonly label: string
  readonly description: string
  readonly parameters: unknown
  readonly approval: 'read'
  readonly loadMode: 'discoverable'
  readonly execute: (
    toolCallId: string,
    params: { readonly questions: readonly PiAskQuestion[] },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: PiAskContext,
  ) => Promise<PiAskToolResult>
}

type PiSchema = {
  readonly object: (shape: Record<string, unknown>) => unknown
  readonly array: (item: unknown) => unknown
  readonly string: () => unknown
  readonly boolean: () => unknown
  readonly number: () => unknown
}

type PiAskExtensionAPI = {
  readonly registerTool?: (tool: PiAskToolDefinition) => void
  readonly zod?: { readonly z?: PiSchema }
}

type BlockingEmitOptions = {
  readonly signal?: AbortSignal
  readonly scriptPath?: string
  readonly timeoutMs?: number
}

type BlockingEmitter = (
  eventName: string,
  event: Record<string, unknown>,
  ctx: ExtensionContext,
  options?: BlockingEmitOptions,
) => Promise<string>

class PiAskCancelledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PiAskCancelledError'
  }
}

type ApprovalSettings = {
  tools?: {
    approvalMode?: unknown
    approval?: Record<string, unknown>
  }
}

type PiToolResultEvent = {
  toolName: string
  input?: Record<string, unknown>
  content?: Array<{ type?: string; text?: string }>
}

// Current OMP dispatches plan approval as a `write` targeting the
// `xd://propose` device URL (see oh-my-pi's tools/resolve.ts).
const PROPOSE_DEVICE_PATH = 'xd://propose'

const isPlanApprovalWriteCall = (event: PiToolResultEvent) => {
  if (event.toolName !== 'write') return false
  const target = event.input?.path ?? event.input?.file_path
  return target === PROPOSE_DEVICE_PATH
}

// ponytail: older OMP versions rode a dedicated `resolve` tool call with
// `action: 'apply'` instead of the `write` + xd://propose dispatch above.
// Cheap to keep supporting both; drop this once nobody's on the old build.
const isLegacyPlanApprovalResolveCall = (event: PiToolResultEvent) =>
  event.toolName === 'resolve' && event.input?.action === 'apply'

export const isPlanApprovalResult = (event: PiToolResultEvent) => {
  if (!isPlanApprovalWriteCall(event) && !isLegacyPlanApprovalResolveCall(event)) return false

  return (
    event.content?.some(
      (content) => content.type === 'text' && content.text?.includes('Plan ready for approval.'),
    ) === true
  )
}

export const isTerminalAgentEnd = (event: PiAgentEndEvent) => event.willContinue !== true

const eventSessionId = (event: Record<string, unknown>) =>
  typeof event.session_id === 'string' && event.session_id.trim()
    ? event.session_id.trim()
    : undefined

const permissionRequestEvent = (event: PiToolApprovalRequestedEvent) => ({
  ...event,
  session_id: event.sessionId,
  hook_event_name: 'PermissionRequest',
  request_id: event.toolCallId,
  tool_call_id: event.toolCallId,
  tool_name: event.toolName,
  approval_mode: event.approvalMode,
})

export const questionAskedEvent = (event: PiToolCallEvent) => ({
  ...event,
  type: 'question.asked',
  hook_event_name: 'QuestionAsked',
  request_id: event.toolCallId,
  tool_call_id: event.toolCallId,
  tool_name: event.toolName,
  properties: {
    id: event.toolCallId,
    questions: Array.isArray(event.input?.questions) ? event.input.questions : [],
  },
})

type ExtensionContext = {
  readonly cwd: string
  readonly sessionManager?: {
    readonly getSessionId?: () => string | undefined
    readonly getSessionFile?: () => string | undefined
  }
}

type ExtensionAPI = {
  on(
    eventName: 'session_start',
    handler: (event: PiSessionEvent, ctx: ExtensionContext) => void,
  ): void
  on(eventName: 'agent_start', handler: (event: PiAgentEvent, ctx: ExtensionContext) => void): void
  on(eventName: 'agent_end', handler: (event: PiAgentEndEvent, ctx: ExtensionContext) => void): void
  on(eventName: 'turn_start', handler: (event: PiTurnEvent, ctx: ExtensionContext) => void): void
  on(
    eventName: 'session_shutdown',
    handler: (event: Record<string, unknown>, ctx: ExtensionContext) => void,
  ): void
  on(
    eventName: 'tool_approval_requested',
    handler: (event: PiToolApprovalRequestedEvent, ctx: ExtensionContext) => void,
  ): void
  on(
    eventName: 'tool_call',
    handler: (event: PiToolCallEvent, ctx: ExtensionContext) => Promise<ToolGateResult | void>,
  ): void
  on(
    eventName: 'tool_result',
    handler: (event: PiToolResultEvent, ctx: ExtensionContext) => void,
  ): void
  registerTool?: PiAskExtensionAPI['registerTool']
  zod?: PiAskExtensionAPI['zod']
}

const sessionHash = (ctx: ExtensionContext) => {
  const manager = ctx.sessionManager
  const sessionId = manager?.getSessionId?.()
  if (sessionId) return sessionId

  fallbackSessionHash ||= `pi:${process.pid}:${Date.now()}:${ctx.cwd}`
  return fallbackSessionHash
}

const readSessionIdFromFile = (filePath: string) => {
  try {
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      if (!line.trim()) continue

      const parsed = JSON.parse(line) as { id?: unknown; type?: unknown }
      if (parsed.type === 'session' && typeof parsed.id === 'string' && parsed.id.trim()) {
        return parsed.id.trim()
      }

      if (parsed.type === undefined && typeof parsed.id === 'string' && parsed.id.trim()) {
        return parsed.id.trim()
      }
    }

    return undefined
  } catch {
    return undefined
  }
}

const subagentSessionInfo = (sessionFile: string) => {
  let dir = path.dirname(sessionFile)
  const sessionRoot = path.dirname(dir)
  let depth = 0

  while (dir !== sessionRoot && dir !== path.dirname(dir)) {
    depth += 1
    const parentSessionFile = path.join(path.dirname(dir), `${path.basename(dir)}.jsonl`)
    if (existsSync(parentSessionFile)) {
      const parentSessionId = readSessionIdFromFile(parentSessionFile)
      if (!parentSessionId) return undefined

      return {
        parentSessionId,
        path: path.relative(path.dirname(parentSessionFile), sessionFile),
        depth,
      }
    }
    dir = path.dirname(dir)
  }

  return undefined
}

const sessionScope = (ctx: ExtensionContext) => {
  const manager = ctx.sessionManager
  const sessionFile = manager?.getSessionFile?.()
  const explicitParent = explicitChildSessionParent()
  if (explicitParent) {
    return {
      parentSessionId: explicitParent,
      path:
        process.env.B2V_CHILD_SESSION_PATH?.trim() ||
        (sessionFile ? path.basename(sessionFile) : sessionHash(ctx)),
      depth: 1,
    }
  }
  if (!sessionFile) return undefined

  return subagentSessionInfo(sessionFile)
}

export const buildPiRawEvent = (
  eventName: string,
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => {
  const scope = sessionScope(ctx)
  const bundleId = expectedBundleId()

  return {
    ...event,
    event: eventName,
    session_id: eventSessionId(event) || sessionHash(ctx),
    cwd: ctx.cwd,
    ...(bundleId ? { expected_bundle_id: bundleId } : {}),
    ...(scope
      ? {
          mode: 'subagent',
          parent_session_hash: scope.parentSessionId,
          child_session_path: scope.path,
          child_session_depth: scope.depth,
        }
      : {}),
  }
}

const emit = async (eventName: string, event: Record<string, unknown>, ctx: ExtensionContext) => {
  try {
    if (isBack2VibingDisabled()) {
      return
    }

    if (!AGENT_EVENT_SCRIPT || AGENT_EVENT_SCRIPT.startsWith('__B2V_')) {
      return
    }

    const rawEvent = buildPiRawEvent(eventName, event, ctx)

    await new Promise<void>((resolve) => {
      let done = false

      const child = spawn(AGENT_EVENT_SCRIPT, [AGENT_ID, '--event', eventName], {
        cwd: ctx.cwd,
        env: process.env,
        stdio: ['pipe', 'ignore', 'ignore'],
      })
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        finish()
      }, AGENT_EVENT_TIMEOUT_MS)
      const finish = () => {
        if (!done) {
          done = true
          clearTimeout(timeout)
          resolve()
        }
      }

      child.on('error', finish)
      child.on('close', finish)
      if (!child.stdin) {
        finish()
        return
      }

      child.stdin.on('error', finish)
      child.stdin.end(JSON.stringify(rawEvent))
    })
  } catch {
    // Never throw from event handlers — omp may stop calling this extension
  }
}

export const emitBlocking = async (
  eventName: string,
  event: Record<string, unknown>,
  ctx: ExtensionContext,
  options: BlockingEmitOptions = {},
): Promise<string> => {
  try {
    const scriptPath = options.scriptPath ?? AGENT_EVENT_SCRIPT
    if (isBack2VibingDisabled()) return ''
    if (!scriptPath || scriptPath.startsWith('__B2V_')) return ''
    if (options.signal?.aborted) return ''

    const rawEvent = buildPiRawEvent(eventName, event, ctx)
    return await new Promise<string>((resolve) => {
      let done = false
      let stdout = ''
      const child = spawn(scriptPath, [AGENT_ID, '--event', eventName], {
        cwd: ctx.cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'ignore'],
      })
      const finish = (value = '') => {
        if (done) return
        done = true
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', abort)
        resolve(value)
      }
      const abort = () => {
        child.kill('SIGKILL')
        finish()
      }
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        finish()
      }, options.timeoutMs ?? GATE_TIMEOUT_MS)

      child.on('error', () => finish())
      child.on('close', () => finish(stdout))
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stdout?.on('error', () => finish())
      if (!child.stdin) {
        finish()
        return
      }
      child.stdin.on('error', () => finish())
      child.stdin.end(JSON.stringify(rawEvent))
      options.signal?.addEventListener('abort', abort, { once: true })
    })
  } catch {
    return ''
  }
}

const schemaHasBuilder = (value: unknown, method: keyof PiSchema): boolean =>
  typeof value === 'object' && value !== null && typeof Reflect.get(value, method) === 'function'

export const canRegisterPiAskBridge = (
  pi: PiAskExtensionAPI,
  scriptPath = AGENT_EVENT_SCRIPT,
): boolean =>
  typeof pi.registerTool === 'function' &&
  Boolean(scriptPath) &&
  !scriptPath.startsWith('__B2V_') &&
  existsSync(scriptPath) &&
  schemaHasBuilder(pi.zod?.z, 'object') &&
  schemaHasBuilder(pi.zod?.z, 'array') &&
  schemaHasBuilder(pi.zod?.z, 'string') &&
  schemaHasBuilder(pi.zod?.z, 'boolean') &&
  schemaHasBuilder(pi.zod?.z, 'number')

const parsePiAskAnswers = (
  stdout: string,
  questions: readonly PiAskQuestion[],
):
  | { readonly kind: 'answers'; readonly answers: readonly PiAskAnswer[] }
  | { readonly kind: 'cancelled' }
  | undefined => {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  if (Reflect.get(value, 'kind') !== 'pi-question') return undefined
  if (Reflect.get(value, 'b2v_question_reply_contract') !== PI_ASK_REPLY_CONTRACT) return undefined
  if (Reflect.get(value, 'cancelled') === true) return { kind: 'cancelled' }

  const rawAnswers = Reflect.get(value, 'answers')
  if (!Array.isArray(rawAnswers) || rawAnswers.length !== questions.length) return undefined
  const answers: PiAskAnswer[] = []
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]
    const rawAnswer = rawAnswers[index]
    if (!question || typeof rawAnswer !== 'object' || rawAnswer === null) return undefined
    if (Reflect.get(rawAnswer, 'id') !== question.id) return undefined

    const selectedOptions = Reflect.get(rawAnswer, 'selectedOptions')
    if (
      !Array.isArray(selectedOptions) ||
      selectedOptions.some((option) => typeof option !== 'string' || !option.trim())
    ) {
      return undefined
    }
    const allowedOptions = new Set(question.options.map((option) => option.label))
    if (selectedOptions.some((option) => !allowedOptions.has(option))) return undefined
    if (new Set(selectedOptions).size !== selectedOptions.length) return undefined
    if (question.multi !== true && selectedOptions.length > 1) return undefined

    const rawCustomInputValue = Reflect.get(rawAnswer, 'customInput')
    const rawCustomInput = rawCustomInputValue === null ? undefined : rawCustomInputValue
    if (
      rawCustomInput !== undefined &&
      (typeof rawCustomInput !== 'string' || !rawCustomInput.trim())
    ) {
      return undefined
    }
    if (selectedOptions.length === 0 && rawCustomInput === undefined) return undefined
    answers.push({
      id: question.id,
      selectedOptions,
      ...(typeof rawCustomInput === 'string' ? { customInput: rawCustomInput } : {}),
    })
  }
  return { kind: 'answers', answers }
}

const parseNativePiAskAnswers = (
  results: readonly PiAskAnswer[],
  questions: readonly PiAskQuestion[],
): readonly PiAskAnswer[] | undefined => {
  if (results.length !== questions.length) return undefined
  const answers: PiAskAnswer[] = []
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]
    const result = results[index]
    if (!question || !result || result.id !== question.id) return undefined
    if (
      !Array.isArray(result.selectedOptions) ||
      result.selectedOptions.some((option) => typeof option !== 'string' || !option.trim())
    ) {
      return undefined
    }
    const allowedOptions = new Set(question.options.map((option) => option.label))
    if (result.selectedOptions.some((option) => !allowedOptions.has(option))) return undefined
    if (new Set(result.selectedOptions).size !== result.selectedOptions.length) return undefined
    if (question.multi !== true && result.selectedOptions.length > 1) return undefined
    if (
      result.customInput !== undefined &&
      (typeof result.customInput !== 'string' || !result.customInput.trim())
    ) {
      return undefined
    }
    if (result.note !== undefined && typeof result.note !== 'string') return undefined
    if (result.timedOut !== undefined && typeof result.timedOut !== 'boolean') return undefined
    answers.push({
      id: question.id,
      selectedOptions: result.selectedOptions,
      ...(result.customInput !== undefined ? { customInput: result.customInput } : {}),
      ...(result.note !== undefined ? { note: result.note } : {}),
      ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
    })
  }
  return answers
}

const formatPiQuestionResult = (answer: PiAskAnswer, question: PiAskQuestion): string => {
  const noteSuffix = answer.note ? ` (note: ${answer.note})` : ''
  if (answer.customInput !== undefined) return `${answer.id}: "${answer.customInput}"${noteSuffix}`
  if (answer.selectedOptions.length > 0) {
    const suffix = `${answer.timedOut ? ' (auto-selected after timeout)' : ''}${noteSuffix}`
    return question.multi === true
      ? `${answer.id}: [${answer.selectedOptions.join(', ')}]${suffix}`
      : `${answer.id}: ${answer.selectedOptions[0]}${suffix}`
  }
  return `${answer.id}: (cancelled)${noteSuffix}`
}

const formatIndentedValue = (label: string, value: string): string =>
  value.includes('\n')
    ? `${label}:\n${value
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')}`
    : `${label}: ${value}`

const buildPiAskResult = (
  questions: readonly PiAskQuestion[],
  answers: readonly PiAskAnswer[],
): PiAskToolResult => {
  const results = questions.map((question, index) => {
    const answer = answers[index]
    if (!answer) throw new PiAskCancelledError('Ask results did not match the requested questions')
    return {
      id: question.id,
      question: question.question,
      options: question.options.map((option) => option.label),
      multi: question.multi ?? false,
      selectedOptions: answer.selectedOptions,
      ...(answer.customInput !== undefined ? { customInput: answer.customInput } : {}),
      ...(answer.note !== undefined ? { note: answer.note } : {}),
      ...(answer.timedOut !== undefined ? { timedOut: answer.timedOut } : {}),
    }
  })
  if (questions.length === 1) {
    const result = results[0]
    if (!result) throw new PiAskCancelledError('Ask result was missing')
    const selectedText = result.multi
      ? `User selected: ${result.selectedOptions.join(', ')}`
      : `User selected: ${result.selectedOptions[0]}`
    const responseParts = [
      ...(result.selectedOptions.length > 0
        ? [result.timedOut ? `${selectedText} (auto-selected after timeout)` : selectedText]
        : []),
      ...(result.customInput !== undefined
        ? [formatIndentedValue('User provided custom input', result.customInput)]
        : []),
      ...(result.note ? [formatIndentedValue('User added note', result.note)] : []),
    ]
    return {
      content: [
        {
          type: 'text',
          text:
            responseParts.length > 0 ? responseParts.join('\n') : 'User cancelled the selection',
        },
      ],
      details: {
        question: result.question,
        options: result.options,
        multi: result.multi,
        selectedOptions: result.selectedOptions,
        ...(result.customInput !== undefined ? { customInput: result.customInput } : {}),
        ...(result.note !== undefined ? { note: result.note } : {}),
        ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
      },
    }
  }
  return {
    content: [
      {
        type: 'text',
        text: `User answers:\n${results.map((result, index) => formatPiQuestionResult(result, questions[index] ?? questions[0])).join('\n')}`,
      },
    ],
    details: { results },
  }
}

const cancelPiAsk = (ctx: PiAskContext, message: string): never => {
  ctx.abort()
  throw new PiAskCancelledError(message)
}

const runNativePiAskFallback = async (
  questions: readonly PiAskQuestion[],
  signal: AbortSignal | undefined,
  ctx: PiAskContext,
): Promise<PiAskToolResult> => {
  if (signal?.aborted) return cancelPiAsk(ctx, 'Ask input was cancelled')
  const askDialog = ctx.ui.askDialog
  if (!askDialog)
    return cancelPiAsk(ctx, 'Back2Vibing bridge failed and the native ask dialog is unavailable')
  const result = await askDialog(questions, { signal })
  if (!result) return cancelPiAsk(ctx, 'Ask tool was cancelled by the user')
  if (result.kind === 'chat') {
    return {
      content: [
        {
          type: 'text',
          text: `User chose to chat about this instead of answering.\n\nQuestions asked:\n${questions.map((question) => question.question).join('\n')}`,
        },
      ],
      details: { chatRedirect: true, questions: questions.map((question) => question.question) },
    }
  }
  const answers = parseNativePiAskAnswers(result.results, questions)
  if (!answers) {
    return cancelPiAsk(ctx, 'Native ask dialog returned invalid answers')
  }
  if (
    questions.length === 1 &&
    answers[0]?.timedOut !== true &&
    answers[0]?.selectedOptions.length === 0 &&
    answers[0]?.customInput === undefined
  ) {
    return cancelPiAsk(ctx, 'Ask tool was cancelled by the user')
  }
  return buildPiAskResult(questions, answers)
}

export const registerPiAskBridge = (
  pi: PiAskExtensionAPI,
  blockingEmitter: BlockingEmitter = emitBlocking,
  scriptPath = AGENT_EVENT_SCRIPT,
): boolean => {
  if (!canRegisterPiAskBridge(pi, scriptPath)) return false
  const z = pi.zod?.z
  if (!z || !pi.registerTool) return false

  const optional = (schema: unknown) => {
    const method =
      typeof schema === 'object' && schema !== null ? Reflect.get(schema, 'optional') : undefined
    return typeof method === 'function' ? Reflect.apply(method, schema, []) : schema
  }
  const callSchemaMethod = (schema: unknown, methodName: string, args: readonly unknown[] = []) => {
    const method =
      typeof schema === 'object' && schema !== null ? Reflect.get(schema, methodName) : undefined
    return typeof method === 'function' ? Reflect.apply(method, schema, args) : schema
  }
  const recommendedSchema = optional(
    callSchemaMethod(callSchemaMethod(z.number(), 'int'), 'nonnegative'),
  )
  const parameters = z.object({
    questions: callSchemaMethod(
      z.array(
        z.object({
          id: z.string(),
          question: z.string(),
          header: optional(z.string()),
          options: z.array(
            z.object({
              label: z.string(),
              description: optional(z.string()),
              preview: optional(z.string()),
            }),
          ),
          multi: optional(z.boolean()),
          recommended: recommendedSchema,
        }),
      ),
      'min',
      [1],
    ),
  })

  pi.registerTool({
    name: 'ask',
    label: 'Ask',
    description: 'Ask the user one or more structured questions and wait for their answers.',
    parameters,
    approval: 'read',
    loadMode: 'discoverable',
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      let stdout = ''
      try {
        stdout = await blockingEmitter(
          'question.asked',
          {
            ...questionAskedEvent({
              toolCallId,
              toolName: 'ask',
              input: { questions: params.questions },
            }),
            b2v_question_reply_contract: PI_ASK_REPLY_CONTRACT,
          },
          ctx,
          { signal, timeoutMs: PI_ASK_TIMEOUT_MS },
        )
      } catch (error) {
        if (signal?.aborted) return cancelPiAsk(ctx, 'Ask input was cancelled')
        if (!(error instanceof Error)) throw error
      }
      if (signal?.aborted) return cancelPiAsk(ctx, 'Ask input was cancelled')
      const parsed = parsePiAskAnswers(stdout, params.questions)
      if (parsed?.kind === 'cancelled')
        return cancelPiAsk(ctx, 'Ask tool was cancelled by the user')
      if (parsed?.kind === 'answers') return buildPiAskResult(params.questions, parsed.answers)
      return await runNativePiAskFallback(params.questions, signal, ctx)
    },
  })
  return true
}

const readApprovalSettings = (filePath: string): ApprovalSettings => {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as ApprovalSettings
  } catch {
    return {}
  }
}

const mergedApprovalSettings = (ctx: ExtensionContext): ApprovalSettings => {
  const configDir = AGENT_ID === 'oh-my-pi' ? '.omp' : '.pi'
  const global = readApprovalSettings(path.join(homedir(), configDir, 'agent', 'settings.json'))
  const project = readApprovalSettings(path.join(ctx.cwd, configDir, 'settings.json'))
  return {
    tools: {
      ...global.tools,
      ...project.tools,
      approval: {
        ...global.tools?.approval,
        ...project.tools?.approval,
      },
    },
  }
}

export const piToolTier = (toolName: string): 'read' | 'write' | 'exec' => {
  if (READ_TOOLS[toolName]) return 'read'
  if (WRITE_TOOLS[toolName]) return 'write'
  return 'exec'
}

export const shouldGatePiToolCall = (
  event: PiToolCallEvent,
  ctx: ExtensionContext,
  gateMode = GATE_MODE,
  allowed = sessionAllowed,
) => {
  if (
    (gateMode !== 'write' && gateMode !== 'always-ask') ||
    event.toolName === 'ask' ||
    allowed.has(event.toolName)
  ) {
    return false
  }

  const tier = piToolTier(event.toolName)
  if (tier === 'read' || (gateMode === 'write' && tier !== 'exec')) return false

  const settings = mergedApprovalSettings(ctx)
  const approvalMode = settings.tools?.approvalMode
  if (typeof approvalMode === 'string' && approvalMode !== 'yolo') return false
  return settings.tools?.approval?.[event.toolName] !== 'allow'
}

export const gatePiToolCall = async (
  event: PiToolCallEvent,
  ctx: ExtensionContext,
  blockingEmitter = emitBlocking,
  gateMode = GATE_MODE,
  allowed = sessionAllowed,
): Promise<ToolGateResult> => {
  if (!shouldGatePiToolCall(event, ctx, gateMode, allowed)) return undefined

  const input = event.input ?? {}
  const command = typeof input.command === 'string' ? input.command : undefined
  const filePath =
    typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : undefined
  const stdout = await blockingEmitter(
    'PermissionRequest',
    {
      ...permissionRequestEvent({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        approvalMode: gateMode,
      }),
      tool_input: input,
      ...(command ? { command } : {}),
      ...(filePath ? { file_path: filePath } : {}),
    },
    ctx,
  )

  let reply: { kind?: unknown; decision?: unknown; reason?: unknown }
  try {
    reply = JSON.parse(stdout) as typeof reply
  } catch {
    return undefined
  }
  if (reply.kind !== 'pi-permission') return undefined
  if (reply.decision === 'allow_always') {
    allowed.add(event.toolName)
    return undefined
  }
  if (reply.decision !== 'deny') return undefined
  const reason = typeof reply.reason === 'string' && reply.reason.trim() ? `: ${reply.reason}` : ''
  return { block: true, reason: `Denied via Back2Vibing${reason}` }
}

export default function back2vibing(pi: ExtensionAPI) {
  const hasAskBridge = registerPiAskBridge(pi)
  let planApprovalPending = false
  let activeContext: ExtensionContext | undefined
  pi.on('session_start', async (event: PiSessionEvent, ctx: ExtensionContext) => {
    activeContext = ctx
    await emit('session_start', event as Record<string, unknown>, ctx)
  })

  pi.on('agent_start', async (event: PiAgentEvent, ctx: ExtensionContext) => {
    activeContext = ctx
    await emit('agent_start', event as Record<string, unknown>, ctx)
  })

  pi.on('tool_result', async (event: PiToolResultEvent) => {
    if (!isPlanApprovalResult(event)) return

    planApprovalPending = true
    if (activeContext) {
      await emit('plan_approval_requested', { reason: 'plan_approval' }, activeContext)
    }
  })

  pi.on('agent_end', async (event: PiAgentEndEvent, ctx: ExtensionContext) => {
    if (planApprovalPending) {
      planApprovalPending = false
      if (!activeContext) {
        await emit('plan_approval_requested', { reason: 'plan_approval' }, ctx)
      }
      return
    }

    if (isTerminalAgentEnd(event)) {
      await emit('agent_end', event, ctx)
    }
  })

  // Turn-level lifecycle: fires once per LLM response + tool calls cycle
  pi.on('turn_start', async (event: PiTurnEvent, ctx: ExtensionContext) => {
    planApprovalPending = false
    activeContext = ctx
    await emit('before_model', event as Record<string, unknown>, ctx)
  })

  pi.on(
    'tool_approval_requested',
    async (event: PiToolApprovalRequestedEvent, ctx: ExtensionContext) => {
      await emit('PermissionRequest', permissionRequestEvent(event), ctx)
    },
  )

  pi.on('tool_call', async (event: PiToolCallEvent, ctx: ExtensionContext) => {
    if (event.toolName === 'ask') {
      if (hasAskBridge) return
      await emit('question.asked', questionAskedEvent(event), ctx)
      return
    }

    return await gatePiToolCall(event, ctx)
  })

  pi.on('session_shutdown', async (event: Record<string, unknown>, ctx: ExtensionContext) => {
    await emit('session_shutdown', event, ctx)
  })
}

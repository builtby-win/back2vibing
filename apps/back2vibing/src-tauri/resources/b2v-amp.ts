import { spawn } from 'node:child_process'
import type { PluginAPI } from '@ampcode/plugin'

// back2vibing Amp Plugin
// Reference: https://ampcode.com/manual/plugin-api

const AGENT_ID = 'sourcegraph-amp'
const SCRIPT_PATH = '__B2V_AGENT_EVENT_SCRIPT_PATH__'
const AGENT_EVENT_TIMEOUT_MS = 5000

type AmpEventContext = {
  thread?: {
    id?: string
  }
}

type AmpThreadEvent = {
  thread?: {
    id?: string
  }
}

type AmpToolEvent = AmpThreadEvent & {
  toolUseID?: string
  tool?: string
  input?: Record<string, unknown>
}

type AmpToolResultEvent = AmpToolEvent & {
  status?: string
  error?: unknown
  output?: unknown
}

type AmpAgentEvent = AmpThreadEvent & {
  id?: string
  message?: string
  status?: string
  messages?: unknown[]
}

function valueAt(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object') {
    return undefined
  }
  return (input as Record<string, unknown>)[key]
}

function nestedValueAt(input: unknown, ...keys: string[]): unknown {
  let current = input
  for (const key of keys) {
    current = valueAt(current, key)
  }
  return current
}

function nestedStringAt(input: unknown, ...keys: string[]): string | undefined {
  const current = nestedValueAt(input, ...keys)
  return typeof current === 'string' && current.length > 0 ? current : undefined
}

function objectAt(input: unknown, key: string): Record<string, unknown> | undefined {
  const value = valueAt(input, key)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function stringAt(input: unknown, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = valueAt(input, key)
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }
  return undefined
}

async function notifyB2V(event: string, data: Record<string, unknown> = {}) {
  const payload = {
    ...data,
    event,
  }

  await new Promise<void>((resolve) => {
    let done = false

    const child = spawn(SCRIPT_PATH, [AGENT_ID, '--event', event], {
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
    child.stdin.end(JSON.stringify(payload))
  })
}

function sessionIdFrom(event: unknown, ctx?: AmpEventContext): string | undefined {
  return (
    nestedStringAt(event, 'thread', 'id') ||
    nestedStringAt(ctx, 'thread', 'id') ||
    stringAt(event, 'session_id', 'sessionId', 'thread_id', 'threadId')
  )
}

function toolNameFrom(event: unknown): string | undefined {
  return stringAt(event, 'tool_name', 'toolName', 'tool') || nestedStringAt(event, 'tool', 'name')
}

function requestIdFrom(event: unknown): string | undefined {
  return stringAt(event, 'toolUseID', 'request_id', 'requestId', 'id')
}

function basePayload(event: unknown, ctx?: AmpEventContext): Record<string, unknown> {
  return {
    session_id: sessionIdFrom(event, ctx),
    thread: objectAt(event, 'thread') || objectAt(ctx, 'thread'),
  }
}

function toolPayload(event: AmpToolEvent, ctx?: AmpEventContext): Record<string, unknown> {
  return {
    ...basePayload(event, ctx),
    request_id: requestIdFrom(event),
    tool_name: toolNameFrom(event),
    toolUseID: event.toolUseID,
    tool: event.tool,
    input: event.input,
  }
}

function agentPayload(event: AmpAgentEvent, ctx?: AmpEventContext): Record<string, unknown> {
  return {
    ...basePayload(event, ctx),
    request_id: requestIdFrom(event),
    message_id: event.id,
    message: event.message,
    status: event.status,
  }
}

export default function back2vibing(amp: PluginAPI) {
  amp.on('session.start', async (event: AmpThreadEvent, ctx: AmpEventContext) => {
    await notifyB2V('on_session_start', {
      ...basePayload(event, ctx),
    })
  })

  amp.on('tool.call', async (event: AmpToolEvent, ctx: AmpEventContext) => {
    await notifyB2V('tool.call', {
      ...toolPayload(event, ctx),
    })

    return { action: 'allow' as const }
  })

  amp.on('tool.result', async (event: AmpToolResultEvent, ctx: AmpEventContext) => {
    await notifyB2V('tool.result', {
      ...toolPayload(event, ctx),
      status: event.status,
      error: event.error,
      output: event.output,
    })
  })

  amp.on('agent.start', async (event: AmpAgentEvent, ctx: AmpEventContext) => {
    await notifyB2V('agent.start', {
      ...agentPayload(event, ctx),
    })
  })

  amp.on('agent.end', async (event: AmpAgentEvent, ctx: AmpEventContext) => {
    await notifyB2V('agent.end', {
      ...agentPayload(event, ctx),
      messages: event.messages,
    })
  })
}

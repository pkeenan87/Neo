import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCreate = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate }
      constructor(_opts?: unknown) {}
    },
  }
})

// No-op executor — we don't exercise the tool-use branch in these tests,
// but the module is imported transitively and must not touch real APIs.
vi.mock('../lib/executors', () => ({
  executeTool: vi.fn(async (_name: string) => ({ ok: true })),
}))

import { runAgentLoop } from '../lib/agent'
import { IncompleteToolUseError } from '../lib/types'
import type { Message } from '../lib/types'

function makeResponse(opts: {
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence'
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >
  inputTokens?: number
  outputTokens?: number
}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    stop_reason: opts.stop_reason,
    stop_sequence: null,
    content: opts.content.map((b) =>
      b.type === 'text'
        ? { type: 'text', text: b.text, citations: null }
        : { type: 'tool_use', id: b.id, name: b.name, input: b.input },
    ),
    usage: {
      input_tokens: opts.inputTokens ?? 100,
      output_tokens: opts.outputTokens ?? 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  }
}

const userMessage: Message[] = [{ role: 'user', content: 'hello' }]

describe('runAgentLoop — stop_reason handling', () => {
  beforeEach(() => {
    mockCreate.mockReset()
  })

  it('end_turn still returns a normal response (regression guard)', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'normal completion' }],
      }),
    )
    const result = await runAgentLoop(userMessage)
    expect(result.type).toBe('response')
    if (result.type !== 'response') throw new Error('wrong result type')
    expect(result.text).toBe('normal completion')
    expect(result.truncated).toBeUndefined()
  })

  it('max_tokens with text content returns truncated:true instead of throwing', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: 'partial response that ran out of room' }],
        outputTokens: 24_000,
      }),
    )
    const result = await runAgentLoop(userMessage)
    expect(result.type).toBe('response')
    if (result.type !== 'response') throw new Error('wrong result type')
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('partial response that ran out of room')
  })

  it('max_tokens where last block is tool_use throws IncompleteToolUseError', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        stop_reason: 'max_tokens',
        content: [
          { type: 'text', text: 'about to call a tool' },
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'run_sentinel_kql',
            input: { query: '...' },
          },
        ],
      }),
    )
    await expect(runAgentLoop(userMessage)).rejects.toThrow(IncompleteToolUseError)
  })

  it('persists a [truncated] marker on the assistant message so reload sees it', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: 'partial' }],
      }),
    )
    const result = await runAgentLoop(userMessage)
    if (result.type !== 'response') throw new Error('wrong result type')
    const lastAssistant = result.messages[result.messages.length - 1]
    expect(lastAssistant.role).toBe('assistant')
    // Array-content assistant message with a trailing "[truncated]" text block.
    if (!Array.isArray(lastAssistant.content)) {
      throw new Error('expected array content on the assistant message')
    }
    const lastBlock = lastAssistant.content[lastAssistant.content.length - 1]
    expect(lastBlock).toMatchObject({ type: 'text', text: '[truncated]' })
  })

  it('truly unexpected stop_reason still throws the "Unexpected stop_reason" error', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        stop_reason: 'stop_sequence',
        content: [{ type: 'text', text: 'weird' }],
      }),
    )
    await expect(runAgentLoop(userMessage)).rejects.toThrow(/Unexpected stop_reason/)
  })
})

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import React from 'react'
import { MessageActions } from '../components/MessageActions'
import { ToastProvider } from '../context/ToastContext'

// The full ChatInterface component requires a lot of context (auth,
// theme, conversation cache, framer-motion, next/image, etc.). For the
// render-predicate coverage we test a tiny harness that mirrors the
// predicate at
// web/components/ChatInterface/ChatInterface.tsx — the `.map((msg, idx) =>`
// assistant-message branch that gates `<MessageActions />`. Keep this
// harness in lockstep with that predicate; if ChatInterface's predicate
// changes, update both.

interface MiniMessage {
  role: 'user' | 'assistant'
  content: string
  skillBadge?: string
  interrupted?: boolean
}

function Harness({
  messages,
  isLoading,
}: {
  messages: MiniMessage[]
  isLoading: boolean
}) {
  // ToastProvider wraps so the nested CopyButton's useToast() call resolves.
  return (
    <ToastProvider>
      <div>
        {messages.map((msg, idx) => (
          <div key={idx} data-testid={`msg-${idx}`}>
            <span>{msg.content}</span>
            {msg.role === 'assistant' &&
              msg.content &&
              !msg.skillBadge &&
              !(isLoading && idx === messages.length - 1) && (
                <MessageActions content={msg.content} />
              )}
          </div>
        ))}
      </div>
    </ToastProvider>
  )
}

// jsdom doesn't ship navigator.clipboard. Install a per-test mock in
// beforeEach and remove it in afterEach so this file doesn't leak a
// module-scoped fake into sibling test files (copy-button.test.tsx
// swaps its own clipboard mock in and out — module-scope setup here
// would win on load order and corrupt that setup).
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  })
})

afterEach(() => {
  cleanup()
  Object.defineProperty(navigator, 'clipboard', {
    value: undefined,
    configurable: true,
  })
})

describe('MessageActions render predicate', () => {
  it('renders for a completed assistant message', () => {
    const { getByRole } = render(
      <Harness
        messages={[{ role: 'assistant', content: 'Neo says hi' }]}
        isLoading={false}
      />,
    )
    expect(
      getByRole('button', { name: /copy message to clipboard/i }),
    ).toBeTruthy()
  })

  it('does NOT render for a user message', () => {
    const { queryByRole } = render(
      <Harness
        messages={[{ role: 'user', content: 'hello neo' }]}
        isLoading={false}
      />,
    )
    expect(
      queryByRole('button', { name: /copy message to clipboard/i }),
    ).toBeNull()
  })

  it('does NOT render for an assistant skill-badge placeholder (empty content)', () => {
    const { queryByRole } = render(
      <Harness
        messages={[{ role: 'assistant', content: '', skillBadge: 'TOR Login' }]}
        isLoading={false}
      />,
    )
    expect(
      queryByRole('button', { name: /copy message to clipboard/i }),
    ).toBeNull()
  })

  it('does NOT render for the last assistant message while streaming', () => {
    const { queryByRole } = render(
      <Harness
        messages={[
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'streaming partial...' },
        ]}
        isLoading={true}
      />,
    )
    expect(
      queryByRole('button', { name: /copy message to clipboard/i }),
    ).toBeNull()
  })

  it('DOES render for an older assistant message even while streaming continues on the latest', () => {
    const { getAllByRole } = render(
      <Harness
        messages={[
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'previous complete response' },
          { role: 'user', content: 'follow-up' },
          { role: 'assistant', content: 'still streaming...' },
        ]}
        isLoading={true}
      />,
    )
    // Only the older assistant gets a copy button; the streaming one does not.
    const buttons = getAllByRole('button', { name: /copy message to clipboard/i })
    expect(buttons).toHaveLength(1)
  })

  it('DOES render for an interrupted assistant message with non-empty content', () => {
    const { getByRole } = render(
      <Harness
        messages={[
          { role: 'assistant', content: 'partial before abort', interrupted: true },
        ]}
        isLoading={false}
      />,
    )
    expect(
      getByRole('button', { name: /copy message to clipboard/i }),
    ).toBeTruthy()
  })
})

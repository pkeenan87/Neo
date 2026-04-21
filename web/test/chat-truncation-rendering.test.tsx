import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ToastProvider } from '../context/ToastContext'

// The full ChatInterface pulls in auth, theme, conversation cache, framer
// motion, next/image — too much for a unit test. The badge-render predicate
// is tiny; we mirror it in a mini-harness so we can assert it in isolation
// (same pattern as chat-tool-traces.test.tsx and chat-message-copy-
// affordance.test.tsx). The full component gets covered indirectly via the
// integration tests when a ChatInterface e2e harness becomes practical.

const TRUNCATED_SUFFIX_RE = /\s*\[truncated\]\s*$/

interface MiniMessage {
  role: 'user' | 'assistant'
  content: string
  interrupted?: boolean
  truncated?: boolean
}

function AssistantBubble({ msg }: { msg: MiniMessage }) {
  if (msg.role !== 'assistant') return null
  return (
    <div data-testid="bubble">
      <span>{msg.content}</span>
      {msg.interrupted && <span data-testid="interrupted-badge">Interrupted</span>}
      {msg.truncated && <span data-testid="truncated-badge">Truncated</span>}
    </div>
  )
}

// Mirrors the `[truncated]`-suffix stripping logic in
// conversationToChatMessages. A persisted assistant message ending with
// [truncated] round-trips to truncated: true on the rendered ChatMessage.
function hydrateFromPersisted(content: string): MiniMessage {
  if (TRUNCATED_SUFFIX_RE.test(content)) {
    return {
      role: 'assistant',
      content: content.replace(TRUNCATED_SUFFIX_RE, '').trim(),
      truncated: true,
    }
  }
  return { role: 'assistant', content }
}

describe('Truncated badge predicate', () => {
  afterEach(() => cleanup())

  it('renders the Truncated badge when truncated: true', () => {
    const { getByTestId } = render(
      <ToastProvider>
        <AssistantBubble
          msg={{ role: 'assistant', content: 'partial response', truncated: true }}
        />
      </ToastProvider>,
    )
    expect(getByTestId('truncated-badge').textContent).toBe('Truncated')
  })

  it('does NOT render the badge when truncated is unset', () => {
    const { queryByTestId } = render(
      <ToastProvider>
        <AssistantBubble msg={{ role: 'assistant', content: 'full response' }} />
      </ToastProvider>,
    )
    expect(queryByTestId('truncated-badge')).toBeNull()
  })

  it('does NOT render the badge when truncated is explicitly false', () => {
    const { queryByTestId } = render(
      <ToastProvider>
        <AssistantBubble
          msg={{ role: 'assistant', content: 'full response', truncated: false }}
        />
      </ToastProvider>,
    )
    expect(queryByTestId('truncated-badge')).toBeNull()
  })

  it('persistence round-trip: [truncated] suffix hydrates to truncated:true and renders the badge', () => {
    const msg = hydrateFromPersisted('the partial answer text\n[truncated]')
    expect(msg.truncated).toBe(true)
    expect(msg.content).toBe('the partial answer text')
    const { getByTestId } = render(
      <ToastProvider>
        <AssistantBubble msg={msg} />
      </ToastProvider>,
    )
    expect(getByTestId('truncated-badge')).toBeTruthy()
  })

  it('plain content without the marker does NOT set truncated on hydrate', () => {
    const msg = hydrateFromPersisted('a full response that mentions [truncated] in the middle')
    expect(msg.truncated).toBeUndefined()
  })

  it('truncated and interrupted can render together (edge case)', () => {
    const { getByTestId } = render(
      <ToastProvider>
        <AssistantBubble
          msg={{
            role: 'assistant',
            content: 'partial then aborted',
            truncated: true,
            interrupted: true,
          }}
        />
      </ToastProvider>,
    )
    expect(getByTestId('interrupted-badge')).toBeTruthy()
    expect(getByTestId('truncated-badge')).toBeTruthy()
  })
})

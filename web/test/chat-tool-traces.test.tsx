import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import type { ToolTrace } from '../lib/types'

// The full ChatInterface pulls in auth, theme, conversation cache, framer
// motion and next/image — too much for a unit test. The tool-summary
// render predicate is small and self-contained, so we mirror it in a
// harness so we can assert the accordion behavior in isolation. If this
// predicate drifts from ChatInterface.tsx, integration coverage at
// chat-message-rendering.test.tsx catches the regression.

interface MiniMessage {
  id: string
  toolsUsed?: string[]
  toolTraces?: ToolTrace[]
}

// Mirrors the tool-summary branch of ChatInterface.tsx.
function ToolSummary({ msg }: { msg: MiniMessage }) {
  if (msg.toolTraces && msg.toolTraces.length > 0) {
    return (
      <div>
        <div id={`tools-label-${msg.id}`}>Tools used:</div>
        <ul role="list" aria-labelledby={`tools-label-${msg.id}`}>
          {msg.toolTraces.map((trace, i) => (
            <li key={`${i}-${trace.name}`}>
              <details>
                <summary>
                  <span>{trace.name}</span>
                  {typeof trace.durationMs === 'number' && (
                    <span data-testid={`duration-${i}`}>
                      {trace.durationMs < 1000
                        ? `${Math.round(trace.durationMs)}ms`
                        : `${(trace.durationMs / 1000).toFixed(2)}s`}
                    </span>
                  )}
                  {trace.isError && <span>error</span>}
                </summary>
                <div>
                  <div>Input</div>
                  <pre data-testid={`input-${i}`}>
                    {JSON.stringify(trace.input, null, 2)}
                  </pre>
                  <div>Output</div>
                  <pre data-testid={`output-${i}`}>
                    {typeof trace.output === 'string'
                      ? trace.output
                      : JSON.stringify(trace.output, null, 2)}
                  </pre>
                </div>
              </details>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  if (msg.toolsUsed && msg.toolsUsed.length > 0) {
    return (
      <div>
        <div id={`tools-label-${msg.id}`}>Tools used:</div>
        <ul role="list" aria-labelledby={`tools-label-${msg.id}`}>
          {msg.toolsUsed.map((tool, i) => (
            <li key={`${i}-${tool}`} data-testid={`bullet-${i}`}>
              {tool}
            </li>
          ))}
        </ul>
      </div>
    )
  }
  return null
}

describe('ToolSummary render predicate', () => {
  afterEach(() => cleanup())

  it('renders the name-only bullet list for legacy toolsUsed (no traces)', () => {
    const { queryAllByRole, getByTestId } = render(
      <ToolSummary msg={{ id: 'm1', toolsUsed: ['run_sentinel_kql', 'get_user_info'] }} />,
    )
    // No <details> accordions in the legacy path.
    expect(queryAllByRole('list')).toHaveLength(1)
    expect(getByTestId('bullet-0').textContent).toBe('run_sentinel_kql')
    expect(getByTestId('bullet-1').textContent).toBe('get_user_info')
    // Summary rows (accordion) should not exist in legacy mode.
    expect(queryAllByRole('group')).toHaveLength(0) // <details> has role=group
  })

  it('renders <details> accordions when toolTraces is present', () => {
    const traces: ToolTrace[] = [
      {
        name: 'run_sentinel_kql',
        input: { query: 'SigninLogs | take 5' },
        output: { rows: [] },
        durationMs: 142,
      },
    ]
    const { getByText } = render(
      <ToolSummary msg={{ id: 'm2', toolTraces: traces }} />,
    )
    // The tool name appears inside the <summary>.
    expect(getByText('run_sentinel_kql')).toBeTruthy()
  })

  it('accordions are collapsed by default (details has no `open` attribute)', () => {
    const traces: ToolTrace[] = [
      { name: 't', input: {}, output: {}, durationMs: 50 },
    ]
    const { container } = render(
      <ToolSummary msg={{ id: 'm3', toolTraces: traces }} />,
    )
    const details = container.querySelector('details')
    expect(details).toBeTruthy()
    expect(details!.hasAttribute('open')).toBe(false)
  })

  it('expanding a <details> exposes input and output content', () => {
    const traces: ToolTrace[] = [
      {
        name: 't',
        input: { x: 1 },
        output: { y: 2 },
        durationMs: 10,
      },
    ]
    const { container, getByTestId } = render(
      <ToolSummary msg={{ id: 'm4', toolTraces: traces }} />,
    )
    const details = container.querySelector('details')!
    // jsdom doesn't natively toggle on summary click like a real browser,
    // but we can open it imperatively to exercise the expanded DOM.
    details.setAttribute('open', '')
    fireEvent.click(details.querySelector('summary')!)
    expect(getByTestId('input-0').textContent).toContain('"x": 1')
    expect(getByTestId('output-0').textContent).toContain('"y": 2')
  })

  it('renders a formatted duration pill (ms under 1s, seconds above)', () => {
    const traces: ToolTrace[] = [
      { name: 'a', input: {}, output: {}, durationMs: 342 },
      { name: 'b', input: {}, output: {}, durationMs: 4250 },
    ]
    const { getByTestId } = render(
      <ToolSummary msg={{ id: 'm5', toolTraces: traces }} />,
    )
    expect(getByTestId('duration-0').textContent).toBe('342ms')
    expect(getByTestId('duration-1').textContent).toBe('4.25s')
  })

  it('omits duration element when durationMs is missing (reload case)', () => {
    const traces: ToolTrace[] = [
      { name: 't', input: {}, output: {} }, // no durationMs
    ]
    const { queryByTestId } = render(
      <ToolSummary msg={{ id: 'm6', toolTraces: traces }} />,
    )
    expect(queryByTestId('duration-0')).toBeNull()
  })
})

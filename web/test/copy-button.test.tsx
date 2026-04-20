import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { CopyButton } from '../components/CopyButton'

// Helper: install a writeText mock on navigator.clipboard. jsdom ships with
// an empty `navigator` — use `Object.defineProperty` with `configurable: true`
// so we can swap implementations per test.
function mockClipboard(impl: (text: string) => Promise<void> | void) {
  const writeText = vi.fn(impl)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
  return writeText
}

function removeClipboard() {
  Object.defineProperty(navigator, 'clipboard', {
    value: undefined,
    configurable: true,
  })
}

describe('CopyButton', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders as a <button> with an accessible label (icon variant)', () => {
    mockClipboard(() => Promise.resolve())
    const { getByRole } = render(<CopyButton text="hello" label="Copy hello" />)
    const btn = getByRole('button', { name: 'Copy hello' })
    expect(btn.tagName.toLowerCase()).toBe('button')
    expect(btn.getAttribute('type')).toBe('button')
  })

  it('defaults the aria-label when none is provided (icon variant)', () => {
    mockClipboard(() => Promise.resolve())
    const { getByRole } = render(<CopyButton text="hi" />)
    expect(getByRole('button', { name: /copy to clipboard/i })).toBeTruthy()
  })

  it('does NOT set aria-label for variant="text" so the visible text becomes the accessible name', () => {
    mockClipboard(() => Promise.resolve())
    const { getByRole } = render(
      <CopyButton text="x" variant="text" label="ignored-for-text" />,
    )
    const btn = getByRole('button', { name: 'Copy' })
    expect(btn.getAttribute('aria-label')).toBeNull()
  })

  it('calls navigator.clipboard.writeText with the exact text prop', async () => {
    const writeText = mockClipboard(() => Promise.resolve())
    const { getByRole } = render(<CopyButton text="payload-body" />)
    fireEvent.click(getByRole('button'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('payload-body'))
  })

  it('keeps a static aria-label on the button and announces "Copied to clipboard" via aria-live', async () => {
    mockClipboard(() => Promise.resolve())
    const { getByRole } = render(<CopyButton text="abc" label="Copy abc" />)
    const btn = getByRole('button', { name: 'Copy abc' })
    fireEvent.click(btn)
    await waitFor(() =>
      expect(getByRole('status').textContent).toMatch(/copied to clipboard/i),
    )
    // Static aria-label — not re-announced to focused-button users, the live
    // region carries the transient message instead.
    expect(btn.getAttribute('aria-label')).toBe('Copy abc')
  })

  it('announces "Copy failed" via aria-live when both clipboard and fallback fail', async () => {
    mockClipboard(() => Promise.reject(new Error('nope')))
    // jsdom doesn't ship execCommand; define it before spying.
    if (typeof document.execCommand !== 'function') {
      Object.defineProperty(document, 'execCommand', {
        value: () => false,
        configurable: true,
        writable: true,
      })
    }
    const execSpy = vi
      .spyOn(document, 'execCommand')
      .mockImplementation(() => false)
    const { getByRole } = render(<CopyButton text="abc" />)
    fireEvent.click(getByRole('button'))
    await waitFor(() =>
      expect(getByRole('status').textContent).toMatch(/copy failed/i),
    )
    execSpy.mockRestore()
  })

  it('uses the execCommand fallback when navigator.clipboard is absent', async () => {
    removeClipboard()
    if (typeof document.execCommand !== 'function') {
      Object.defineProperty(document, 'execCommand', {
        value: () => true,
        configurable: true,
        writable: true,
      })
    }
    const execSpy = vi
      .spyOn(document, 'execCommand')
      .mockImplementation(() => true)
    const { getByRole } = render(<CopyButton text="fallback" />)
    fireEvent.click(getByRole('button'))
    await waitFor(() => expect(execSpy).toHaveBeenCalled())
    execSpy.mockRestore()
  })

  it('renders text content in variant="text" and swaps to "Copied!" on success', async () => {
    mockClipboard(() => Promise.resolve())
    const { getByRole } = render(<CopyButton text="x" variant="text" />)
    const btn = getByRole('button')
    expect(btn.textContent).toBe('Copy')
    fireEvent.click(btn)
    await waitFor(() => expect(btn.textContent).toBe('Copied!'))
  })
})

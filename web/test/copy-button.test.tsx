import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { CopyButton } from '../components/CopyButton'
import { ToastProvider, useToast } from '../context/ToastContext'

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

// Render-wrapper that also exposes the toast() output via a spy ref. We
// expose it by rendering a small probe component inside the provider that
// writes every new toast title into the shared `toastSpy` array — this
// lets us assert which intents/titles were pushed without needing to
// render the full <Toaster /> portal UI.
function renderWithToast(ui: ReactNode) {
  const titles: Array<{ intent: string | undefined; title: string }> = []
  function Probe() {
    const { toasts } = useToast()
    // Capture any new toasts by their id; because we push in order, length
    // tracks additions reliably for the small test cases here.
    while (titles.length < toasts.length) {
      const t = toasts[titles.length]
      titles.push({ intent: t.intent, title: t.title })
    }
    return null
  }
  const result = render(
    <ToastProvider>
      <Probe />
      {ui}
    </ToastProvider>,
  )
  return { ...result, toastTitles: titles }
}

describe('CopyButton', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders as a <button> with an accessible label (icon variant)', () => {
    mockClipboard(() => Promise.resolve())
    const { getByRole } = renderWithToast(<CopyButton text="hello" label="Copy hello" />)
    const btn = getByRole('button', { name: 'Copy hello' })
    expect(btn.tagName.toLowerCase()).toBe('button')
    expect(btn.getAttribute('type')).toBe('button')
  })

  it('defaults the aria-label when none is provided (icon variant)', () => {
    mockClipboard(() => Promise.resolve())
    const { getByRole } = renderWithToast(<CopyButton text="hi" />)
    expect(getByRole('button', { name: /copy to clipboard/i })).toBeTruthy()
  })

  it('does NOT set aria-label for variant="text" so the visible text becomes the accessible name', () => {
    mockClipboard(() => Promise.resolve())
    const { getByRole } = renderWithToast(
      <CopyButton text="x" variant="text" label="ignored-for-text" />,
    )
    const btn = getByRole('button', { name: 'Copy' })
    expect(btn.getAttribute('aria-label')).toBeNull()
  })

  it('calls navigator.clipboard.writeText with the exact text prop', async () => {
    const writeText = mockClipboard(() => Promise.resolve())
    const { getByRole } = renderWithToast(<CopyButton text="payload-body" />)
    fireEvent.click(getByRole('button'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('payload-body'))
  })

  it('keeps a static aria-label on the button and pushes a success toast', async () => {
    mockClipboard(() => Promise.resolve())
    const { getByRole, toastTitles } = renderWithToast(
      <CopyButton text="abc" label="Copy abc" />,
    )
    const btn = getByRole('button', { name: 'Copy abc' })
    fireEvent.click(btn)
    await waitFor(() => {
      expect(
        toastTitles.some(
          (t) => t.intent === 'success' && /copied to clipboard/i.test(t.title),
        ),
      ).toBe(true)
    })
    // Static aria-label — the transient message is carried by the toast,
    // not a changing label on the focused button.
    expect(btn.getAttribute('aria-label')).toBe('Copy abc')
  })

  it('pushes an error toast when both clipboard and fallback fail', async () => {
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
    const { getByRole, toastTitles } = renderWithToast(<CopyButton text="abc" />)
    fireEvent.click(getByRole('button'))
    await waitFor(() => {
      expect(
        toastTitles.some(
          (t) => t.intent === 'error' && /copy failed/i.test(t.title),
        ),
      ).toBe(true)
    })
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
    const { getByRole } = renderWithToast(<CopyButton text="fallback" />)
    fireEvent.click(getByRole('button'))
    await waitFor(() => expect(execSpy).toHaveBeenCalled())
    execSpy.mockRestore()
  })

  it('renders text content in variant="text" and swaps to "Copied!" on success', async () => {
    mockClipboard(() => Promise.resolve())
    const { getByRole } = renderWithToast(<CopyButton text="x" variant="text" />)
    const btn = getByRole('button')
    expect(btn.textContent).toBe('Copy')
    fireEvent.click(btn)
    await waitFor(() => expect(btn.textContent).toBe('Copied!'))
  })
})

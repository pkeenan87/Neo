import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReactElement } from 'react'
import { ToastProvider } from '../context/ToastContext'
import { ThemeProvider } from '../context/ThemeContext'

// SkillsSection-level component tests. The route handlers are mocked
// at the fetch boundary; the component is exercised end-to-end inside
// the test's React tree.

function render(ui: ReactElement) {
  return rtlRender(
    <ThemeProvider>
      <ToastProvider>{ui}</ToastProvider>
    </ThemeProvider>,
  )
}

interface MockResponse {
  status: number
  body: unknown
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
let responseQueue: Map<string, MockResponse[]> = new Map()

function queueResponse(method: string, url: string, body: unknown, status = 200) {
  const key = `${method.toUpperCase()} ${url}`
  if (!responseQueue.has(key)) responseQueue.set(key, [])
  responseQueue.get(key)!.push({ status, body })
}

function makeJsonResponse({ status, body }: MockResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// jsdom doesn't ship matchMedia; ThemeProvider needs it.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

beforeEach(() => {
  responseQueue = new Map()
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const key = `${method} ${url}`
    const queue = responseQueue.get(key) ?? []
    const next = queue.shift()
    if (next) return makeJsonResponse(next)
    return makeJsonResponse({ status: 500, body: { error: `unhandled ${key}` } })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

import { SettingsPage } from '../components/SettingsPage/SettingsPage'

describe('SettingsPage — Skills tab visibility', () => {
  it('does NOT render the Skills tab when userRole is reader', () => {
    queueResponse('GET', '/api/skills', { skills: [] }) // not actually called
    render(<SettingsPage userName="Alice" userRole="reader" />)
    expect(screen.queryByRole('tab', { name: /skills/i })).toBeNull()
  })

  it('does NOT render the Skills tab when userRole is triage', () => {
    render(<SettingsPage userName="Alice" userRole="triage" />)
    expect(screen.queryByRole('tab', { name: /skills/i })).toBeNull()
  })

  it('renders the Skills tab when userRole is admin', () => {
    render(<SettingsPage userName="Alice" userRole="admin" />)
    expect(screen.getByRole('tab', { name: /skills/i })).toBeInTheDocument()
  })
})

describe('SkillsSection — list view', () => {
  it('fetches /api/skills on mount and renders rows', async () => {
    queueResponse('GET', '/api/skills', {
      skills: [
        {
          id: 'tor-login-investigation',
          name: 'TOR Login Investigation',
          description: 'Triage a TOR sign-in alert.',
          requiredTools: ['run_sentinel_kql', 'get_user_info'],
          requiredRole: 'reader',
          parameters: ['upn', 'timeframe'],
        },
      ],
    })

    render(<SettingsPage userName="Alice" userRole="admin" />)
    fireEvent.click(screen.getByRole('tab', { name: /skills/i }))

    await waitFor(() => expect(screen.getByText('tor-login-investigation')).toBeInTheDocument())
    expect(screen.getByText('TOR Login Investigation')).toBeInTheDocument()
    expect(screen.getByText('Triage a TOR sign-in alert.')).toBeInTheDocument()
  })

  it('renders the empty state when no skills exist', async () => {
    queueResponse('GET', '/api/skills', { skills: [] })

    render(<SettingsPage userName="Alice" userRole="admin" />)
    fireEvent.click(screen.getByRole('tab', { name: /skills/i }))

    await waitFor(() => expect(screen.getByText(/no skills yet/i)).toBeInTheDocument())
  })
})

import { SkillEditor } from '../components/SettingsPage/SkillEditor'

describe('SkillEditor', () => {
  // The previous "live parser preview" tests were retired with the
  // right-column preview card itself. The server-side validators in
  // skill-parser.ts still enforce identical rules (unknown tools,
  // destructive-tool + reader-role mismatch, missing description) on
  // POST/PUT — see the route handler tests for that coverage.
  it('does NOT call POST /api/skills when the id fails client-side validation', () => {
    render(<SkillEditor mode="create" onCancel={() => {}} onSaved={() => {}} />)

    const idInput = screen.getByLabelText(/^id/i) as HTMLInputElement
    // Uppercase letters fail VALID_ID
    fireEvent.change(idInput, { target: { value: 'BadID' } })

    fireEvent.click(screen.getByRole('button', { name: /create skill/i }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByText(/lowercase alphanumeric characters and hyphens/i)).toBeInTheDocument()
  })

  it('serializes structured form fields to canonical markdown and POSTs { id, content }', async () => {
    queueResponse('POST', '/api/skills', { skill: {} }, 201)
    const onSaved = vi.fn()

    render(<SkillEditor mode="create" onCancel={() => {}} onSaved={onSaved} />)

    fireEvent.change(screen.getByLabelText(/^id/i), { target: { value: 'my-new-skill' } })
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'My New Skill' } })
    fireEvent.change(screen.getByLabelText(/^description$/i), {
      target: { value: 'Triages thing X.' },
    })
    fireEvent.change(screen.getByLabelText(/^required role$/i), {
      target: { value: 'admin' },
    })

    fireEvent.click(screen.getByRole('button', { name: /create skill/i }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())

    const call = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/skills' && (init as RequestInit)?.method === 'POST',
    )
    expect(call).toBeDefined()
    const body = JSON.parse(((call![1] as RequestInit).body as string) ?? '{}') as {
      id: string
      content: string
    }
    expect(body.id).toBe('my-new-skill')
    expect(body.content).toContain('# Skill: My New Skill')
    expect(body.content).toContain('## Description')
    expect(body.content).toContain('Triages thing X.')
    expect(body.content).toContain('## Required Role')
    expect(body.content).toMatch(/## Required Role\s+admin/)
  })

  it('refuses to render the form body when hydration fails (no destructive save with defaults)', async () => {
    // Regression: pre-fix, a 500 on GET /api/skills/[id] left loading=false
    // and rendered the form populated with new-skill DEFAULT_FORM_STATE
    // plus an enabled Save button. Clicking Save would PUT defaults
    // over the real skill. Now the form body is gated on `hydrated`.
    queueResponse('GET', '/api/skills/oops', { error: 'boom' }, 500)

    render(
      <SkillEditor mode="edit" skillId="oops" onCancel={() => {}} onSaved={() => {}} />,
    )

    await waitFor(() => expect(screen.getByText(/failed to load skill/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull()
    expect(screen.queryByLabelText(/^name$/i)).toBeNull()
  })

  it('hydrates the form from the parsed Skill returned by GET /api/skills/[id]', async () => {
    queueResponse('GET', '/api/skills/existing', {
      skill: {
        id: 'existing',
        name: 'Existing Skill',
        description: 'Already saved description.',
        instructions: '### 1. Step\n\nDo the thing.',
        requiredTools: ['run_sentinel_kql'],
        requiredRole: 'reader',
        parameters: ['upn'],
      },
    })

    render(
      <SkillEditor mode="edit" skillId="existing" onCancel={() => {}} onSaved={() => {}} />,
    )

    await waitFor(() =>
      expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe('Existing Skill'),
    )
    expect((screen.getByLabelText(/^description$/i) as HTMLTextAreaElement).value).toBe(
      'Already saved description.',
    )
    expect((screen.getByLabelText(/^required role$/i) as HTMLSelectElement).value).toBe('reader')
    expect(screen.getByText('run_sentinel_kql')).toBeInTheDocument()
  })
})

import { SkillDeleteConfirmModal } from '../components/SettingsPage/SkillDeleteConfirmModal'

describe('SkillDeleteConfirmModal', () => {
  const skill = {
    id: 'demo-skill',
    name: 'Demo',
    description: 'd',
    requiredTools: [],
    requiredRole: 'reader' as const,
    parameters: [],
  }

  it('disables Delete until the typed id matches', () => {
    render(<SkillDeleteConfirmModal skill={skill} onCancel={() => {}} onDeleted={() => {}} />)

    const button = screen.getByRole('button', { name: /^delete$/i })
    expect(button).toBeDisabled()

    const input = screen.getByLabelText(/type demo-skill/i)
    fireEvent.change(input, { target: { value: 'demo-skil' } })
    expect(button).toBeDisabled()

    fireEvent.change(input, { target: { value: 'demo-skill' } })
    expect(button).not.toBeDisabled()
  })

  it('calls DELETE /api/skills/[id] once and invokes onDeleted on 200', async () => {
    queueResponse('DELETE', '/api/skills/demo-skill', { deleted: true })
    const onDeleted = vi.fn()

    render(<SkillDeleteConfirmModal skill={skill} onCancel={() => {}} onDeleted={onDeleted} />)
    fireEvent.change(screen.getByLabelText(/type demo-skill/i), { target: { value: 'demo-skill' } })
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))

    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/skills/demo-skill',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('renders blockingMappings list and locks Delete when the server returns 409', async () => {
    queueResponse(
      'DELETE',
      '/api/skills/demo-skill',
      {
        error: 'Skill is referenced by triage mappings — reassign or remove them first.',
        blockingMappings: [
          'DefenderXDR:DefenderEndpoint.SuspiciousProcess',
          'Sentinel:HighSeverity',
        ],
      },
      409,
    )

    render(<SkillDeleteConfirmModal skill={skill} onCancel={() => {}} onDeleted={() => {}} />)
    fireEvent.change(screen.getByLabelText(/type demo-skill/i), { target: { value: 'demo-skill' } })
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))

    // Once the 409 lands, the type-to-confirm input + Delete button
    // unmount and the dialog swaps into the blocking-mappings state.
    await waitFor(() =>
      expect(
        screen.getByText(/referenced by 2 triage mappings/i),
      ).toBeInTheDocument(),
    )
    expect(screen.getByText('DefenderXDR:DefenderEndpoint.SuspiciousProcess')).toBeInTheDocument()
    expect(screen.getByText('Sentinel:HighSeverity')).toBeInTheDocument()

    // Delete button is gone; only Close remains.
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull()
    expect(screen.getByRole('button', { name: /^close$/i })).toBeInTheDocument()
    // The type-to-confirm input is also unmounted in this state.
    expect(screen.queryByLabelText(/type demo-skill/i)).toBeNull()
  })
})

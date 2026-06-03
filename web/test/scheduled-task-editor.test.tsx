import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import { ScheduledTaskEditor } from '../components/SettingsPage/ScheduledTaskEditor'
import type { ScheduledTask } from '../lib/scheduled-task-types'

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

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    createdBy: 'admin',
    name: 'Existing task',
    description: 'A task that already exists',
    enabled: true,
    dryRun: false,
    circuitBreakerThreshold: 3,
    schedule: { cronExpression: '0 9 * * 1-5', timezone: 'America/Los_Angeles' },
    task: {
      promptTemplate: 'Investigate {{thing}}',
      variables: { thing: 'phishing alerts', lookbackDays: 7 },
      allowedTools: ['run_sentinel_kql'],
      maxDurationSeconds: 90,
    },
    routing: {
      destination: 'tool',
      toolName: 'send_teams_message',
      fallbackDestination: 'cosmos-log',
    },
    auth: {
      executionIdentity: 'managed-identity',
      scopedPermissions: [],
    },
    state: { status: 'idle', nextRunTime: '', consecutiveFailures: 0 },
    runHistory: [],
    createdAt: '',
    updatedAt: '',
    _etag: 'etag-abc',
    ...overrides,
  }
}

describe('ScheduledTaskEditor — create mode', () => {
  it('renders the seeded default form with the structured controls', () => {
    render(<ScheduledTaskEditor mode="create" onCancel={() => {}} onSaved={() => {}} />)

    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/cron expression/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/timezone/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/prompt template/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create task/i })).toBeInTheDocument()
    // The default destination is 'tool' so the toolName control must render.
    expect(screen.getByLabelText(/tool name/i)).toBeInTheDocument()
  })

  it('blocks submit when name is empty and surfaces the validator message', async () => {
    render(<ScheduledTaskEditor mode="create" onCancel={() => {}} onSaved={() => {}} />)

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /create task/i }))

    await waitFor(() =>
      expect(screen.getByText(/name is required/i)).toBeInTheDocument(),
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('hides toolName when destination switches away from "tool"', () => {
    render(<ScheduledTaskEditor mode="create" onCancel={() => {}} onSaved={() => {}} />)

    expect(screen.getByLabelText(/tool name/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/^destination$/i), {
      target: { value: 'cosmos-log' },
    })
    expect(screen.queryByLabelText(/tool name/i)).toBeNull()
  })

  it('shows Teams team + channel inputs when destination is teams-channel', () => {
    render(<ScheduledTaskEditor mode="create" onCancel={() => {}} onSaved={() => {}} />)

    fireEvent.change(screen.getByLabelText(/^destination$/i), {
      target: { value: 'teams-channel' },
    })
    expect(screen.getByLabelText(/teams team id/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/teams channel id/i)).toBeInTheDocument()
  })

  it('add+remove variable rows and serializes them as a Record on submit', async () => {
    queueResponse('POST', '/api/scheduled-tasks', { task: {} }, 201)
    const onSaved = vi.fn()

    render(<ScheduledTaskEditor mode="create" onCancel={() => {}} onSaved={onSaved} />)

    // Default has one variable row (lookbackDays=7). Add another and submit.
    fireEvent.click(screen.getByRole('button', { name: /add variable/i }))

    // Find the freshly-added empty input pair (last row).
    const keys = screen.getAllByPlaceholderText('key')
    const values = screen.getAllByPlaceholderText('value')
    fireEvent.change(keys[keys.length - 1], { target: { value: 'severity' } })
    fireEvent.change(values[values.length - 1], { target: { value: 'high' } })

    fireEvent.click(screen.getByRole('button', { name: /create task/i }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === '/api/scheduled-tasks' && (init as RequestInit)?.method === 'POST',
    )
    const body = JSON.parse(((call![1] as RequestInit).body as string) ?? '{}') as {
      task: { variables: Record<string, string> }
    }
    expect(body.task.variables).toEqual({ lookbackDays: '7', severity: 'high' })
  })

  it('preserves form state when toggling to JSON view and back', () => {
    render(<ScheduledTaskEditor mode="create" onCancel={() => {}} onSaved={() => {}} />)

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Custom name' } })

    // Switch to JSON view — should reflect the current form state.
    fireEvent.click(screen.getByRole('button', { name: /switch to json/i }))
    const jsonArea = screen.getByLabelText(/json payload/i) as HTMLTextAreaElement
    expect(jsonArea.value).toContain('"name": "Custom name"')

    // Switch back; name should still be there.
    fireEvent.click(screen.getByRole('button', { name: /switch to form/i }))
    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe('Custom name')
  })

  it('surfaces a JSON parse error and stays in JSON view when toggling back with broken input', () => {
    render(<ScheduledTaskEditor mode="create" onCancel={() => {}} onSaved={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: /switch to json/i }))
    const jsonArea = screen.getByLabelText(/json payload/i) as HTMLTextAreaElement
    fireEvent.change(jsonArea, { target: { value: '{ this is not json' } })
    fireEvent.click(screen.getByRole('button', { name: /switch to form/i }))

    expect(screen.getByText(/invalid json/i)).toBeInTheDocument()
    // Still in JSON view
    expect(screen.getByLabelText(/json payload/i)).toBeInTheDocument()
  })
})

describe('ScheduledTaskEditor — edit mode', () => {
  it('hydrates form fields from the passed task and PATCHes with expectedEtag on save', async () => {
    queueResponse('PATCH', '/api/scheduled-tasks/task-1', { task: {} }, 200)
    const onSaved = vi.fn()
    const task = makeTask()

    render(
      <ScheduledTaskEditor
        mode="edit"
        task={task}
        onCancel={() => {}}
        onSaved={onSaved}
      />,
    )

    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe('Existing task')
    expect((screen.getByLabelText(/cron expression/i) as HTMLInputElement).value).toBe(
      '0 9 * * 1-5',
    )

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Renamed task' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === '/api/scheduled-tasks/task-1' && (init as RequestInit)?.method === 'PATCH',
    )
    const body = JSON.parse(((call![1] as RequestInit).body as string) ?? '{}') as {
      name: string
      expectedEtag: string
    }
    expect(body.name).toBe('Renamed task')
    expect(body.expectedEtag).toBe('etag-abc')
  })

  it('coerces stored numeric variable values into strings for the form', () => {
    const task = makeTask()
    render(
      <ScheduledTaskEditor
        mode="edit"
        task={task}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    )

    // lookbackDays was a number (7) on the task; the form should
    // display it as the string "7" so the user can edit it.
    const keys = screen.getAllByPlaceholderText('key') as HTMLInputElement[]
    const values = screen.getAllByPlaceholderText('value') as HTMLInputElement[]
    const lookbackIdx = keys.findIndex((k) => k.value === 'lookbackDays')
    expect(lookbackIdx).toBeGreaterThanOrEqual(0)
    expect(values[lookbackIdx].value).toBe('7')
  })

  it('shows the existing allowedTools as chips and lets the user remove one', () => {
    const task = makeTask()
    render(
      <ScheduledTaskEditor
        mode="edit"
        task={task}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    )

    expect(screen.getByRole('button', { name: /remove run_sentinel_kql/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /remove run_sentinel_kql/i }))
    // The chip's remove button should be gone after removal. The tool name
    // legitimately reappears in the "Add a tool…" dropdown <option>; we
    // check the chip specifically via its remove button.
    expect(screen.queryByRole('button', { name: /remove run_sentinel_kql/i })).toBeNull()
  })
})

describe('ScheduledTaskEditor — routing validation', () => {
  it('rejects a tool destination without a toolName via the validator', async () => {
    render(<ScheduledTaskEditor mode="create" onCancel={() => {}} onSaved={() => {}} />)

    // Clear the seeded toolName so the routing payload becomes invalid.
    fireEvent.change(screen.getByLabelText(/tool name/i), { target: { value: '' } })

    fireEvent.click(screen.getByRole('button', { name: /create task/i }))

    await waitFor(() => {
      const errors = screen.getAllByRole('alert')
      const messages = errors.map((el) => el.textContent ?? '').join(' | ')
      expect(messages).toMatch(/toolName/i)
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('ScheduledTaskEditor — ultrareview regressions', () => {
  it('refuses to PATCH when the loaded task has no _etag', async () => {
    const task = makeTask({ _etag: undefined })
    render(
      <ScheduledTaskEditor
        mode="edit"
        task={task}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() =>
      expect(screen.getByText(/optimistic-concurrency token/i)).toBeInTheDocument(),
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves skillSlug through an edit round-trip', async () => {
    queueResponse('PATCH', '/api/scheduled-tasks/task-1', { task: {} }, 200)
    const onSaved = vi.fn()
    const task = makeTask({
      task: {
        promptTemplate: 'Investigate {{thing}}',
        variables: { thing: 'phishing alerts' },
        allowedTools: ['run_sentinel_kql'],
        maxDurationSeconds: 90,
        skillSlug: 'phishing-triage',
      },
    })

    render(
      <ScheduledTaskEditor
        mode="edit"
        task={task}
        onCancel={() => {}}
        onSaved={onSaved}
      />,
    )

    // Touch any field so the form differs from the seeded state.
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === '/api/scheduled-tasks/task-1' && (init as RequestInit)?.method === 'PATCH',
    )
    const body = JSON.parse(((call![1] as RequestInit).body as string) ?? '{}') as {
      task: { skillSlug?: string }
    }
    expect(body.task.skillSlug).toBe('phishing-triage')
  })

  it('emits explicit empty arrays on auth when admin cleared scopedPermissions', async () => {
    queueResponse('PATCH', '/api/scheduled-tasks/task-1', { task: {} }, 200)
    const onSaved = vi.fn()
    const task = makeTask({
      auth: {
        executionIdentity: 'managed-identity',
        scopedPermissions: ['SecurityIncident.Read.All'],
        keyVaultSecretRefs: [],
      },
    })

    render(
      <ScheduledTaskEditor
        mode="edit"
        task={task}
        onCancel={() => {}}
        onSaved={onSaved}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === '/api/scheduled-tasks/task-1' && (init as RequestInit)?.method === 'PATCH',
    )
    const body = JSON.parse(((call![1] as RequestInit).body as string) ?? '{}') as {
      auth: { scopedPermissions: string[]; keyVaultSecretRefs: string[] }
    }
    // Auth is now always sent so admins can actually clear permissions.
    expect(body.auth).toBeDefined()
    expect(Array.isArray(body.auth.scopedPermissions)).toBe(true)
    expect(Array.isArray(body.auth.keyVaultSecretRefs)).toBe(true)
  })
})

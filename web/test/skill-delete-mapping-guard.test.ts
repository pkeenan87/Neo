import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// New behaviour: DELETE /api/skills/[id] must return HTTP 409 with a
// `blockingMappings` array when one or more triage mappings reference
// the skill. The Skills delete modal handles that response by
// surfacing the blocking keys and disabling the destructive control.

const {
  loggerMocks,
  resolveAuthMock,
  getSkillMock,
  deleteSkillMock,
  getMappingsForSkillMock,
} = vi.hoisted(() => {
  return {
    loggerMocks: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      emitEvent: vi.fn(),
    },
    resolveAuthMock: vi.fn(),
    getSkillMock: vi.fn(),
    deleteSkillMock: vi.fn(),
    getMappingsForSkillMock: vi.fn(),
  }
})

vi.mock('../lib/logger', async () => {
  const actual = await vi.importActual<typeof import('../lib/logger')>('../lib/logger')
  return {
    ...actual,
    logger: loggerMocks,
    hashPii: actual.hashPii,
  }
})

vi.mock('../lib/auth-helpers', () => ({
  resolveAuth: () => resolveAuthMock(),
}))

vi.mock('../lib/skill-store', async () => {
  const actual = await vi.importActual<typeof import('../lib/skill-store')>('../lib/skill-store')
  return {
    ...actual,
    getSkill: (...args: unknown[]) => getSkillMock(...args),
    deleteSkill: (...args: unknown[]) => deleteSkillMock(...args),
  }
})

vi.mock('../lib/triage-mapping-store', () => ({
  getMappingsForSkill: (...args: unknown[]) => getMappingsForSkillMock(...args),
}))

const ADMIN = {
  ownerId: 'admin-id',
  name: 'admin@example.com',
  role: 'admin',
  provider: 'entra-id',
}

beforeEach(() => {
  Object.values(loggerMocks).forEach((m) => {
    if (typeof m === 'function' && 'mockReset' in m) (m as { mockReset: () => void }).mockReset()
  })
  resolveAuthMock.mockReset()
  getSkillMock.mockReset()
  deleteSkillMock.mockReset()
  getMappingsForSkillMock.mockReset()

  resolveAuthMock.mockResolvedValue(ADMIN)
  getSkillMock.mockResolvedValue({ id: 'defender-endpoint-triage' })
})

afterEach(() => {
  vi.resetModules()
})

const params = Promise.resolve({ id: 'defender-endpoint-triage' })

describe('DELETE /api/skills/[id] — triage-mapping guard', () => {
  it('returns 409 with blockingMappings when one mapping references the skill', async () => {
    getMappingsForSkillMock.mockResolvedValue([
      {
        id: 'DefenderXDR:DefenderEndpoint.SuspiciousProcess',
        skillId: 'defender-endpoint-triage',
        updatedAt: '2026-05-07T00:00:00.000Z',
        updatedBy: 'x',
      },
    ])

    const { DELETE } = await import('../app/api/skills/[id]/route')
    const req = new Request('http://localhost/api/skills/defender-endpoint-triage', {
      method: 'DELETE',
    })
    const res = await DELETE(req as never, { params } as never)

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/referenced by triage mappings/i)
    expect(body.blockingMappings).toEqual(['DefenderXDR:DefenderEndpoint.SuspiciousProcess'])
    expect(deleteSkillMock).not.toHaveBeenCalled()
  })

  it('returns 409 with all blocking keys when multiple mappings reference the skill', async () => {
    getMappingsForSkillMock.mockResolvedValue([
      { id: 'DefenderXDR:Foo', skillId: 'defender-endpoint-triage', updatedAt: '', updatedBy: '' },
      { id: 'DefenderXDR:Bar', skillId: 'defender-endpoint-triage', updatedAt: '', updatedBy: '' },
      { id: 'Sentinel:Baz', skillId: 'defender-endpoint-triage', updatedAt: '', updatedBy: '' },
    ])

    const { DELETE } = await import('../app/api/skills/[id]/route')
    const req = new Request('http://localhost/api/skills/defender-endpoint-triage', {
      method: 'DELETE',
    })
    const res = await DELETE(req as never, { params } as never)

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.blockingMappings).toEqual(['DefenderXDR:Foo', 'DefenderXDR:Bar', 'Sentinel:Baz'])
    expect(deleteSkillMock).not.toHaveBeenCalled()
  })

  it('proceeds with deletion when no mappings reference the skill', async () => {
    getMappingsForSkillMock.mockResolvedValue([])
    deleteSkillMock.mockResolvedValue(undefined)

    const { DELETE } = await import('../app/api/skills/[id]/route')
    const req = new Request('http://localhost/api/skills/defender-endpoint-triage', {
      method: 'DELETE',
    })
    const res = await DELETE(req as never, { params } as never)

    expect(res.status).toBe(200)
    expect(deleteSkillMock).toHaveBeenCalledWith('defender-endpoint-triage')
    expect(loggerMocks.emitEvent).toHaveBeenCalledTimes(1)
    const [eventType] = loggerMocks.emitEvent.mock.calls[0]
    expect(eventType).toBe('skill_modified')
  })

  it('fails closed with 503 when the mapping store throws (Cosmos outage)', async () => {
    // The strict-list path in getMappingsForSkill propagates Cosmos
    // errors. The route must wrap that in try/catch and return 503
    // rather than letting the delete proceed (false-empty would
    // orphan mappings) or letting a bare 500 reach the admin (which
    // they might interpret as "retry the delete").
    getMappingsForSkillMock.mockRejectedValue(new Error('Cosmos timeout'))

    const { DELETE } = await import('../app/api/skills/[id]/route')
    const req = new Request('http://localhost/api/skills/defender-endpoint-triage', {
      method: 'DELETE',
    })
    const res = await DELETE(req as never, { params } as never)

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toMatch(/please retry/i)
    // Critically: the destructive delete must NOT have run.
    expect(deleteSkillMock).not.toHaveBeenCalled()
  })
})

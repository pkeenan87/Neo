import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/triage-mappings/test — admin-only preview endpoint that
// runs `resolveTriageSkill` against the live store and returns
// `{ skillId, source: 'mapped' | 'generic' | 'none' }` without
// recording a triage run.

const { resolveAuthMock, resolveTriageSkillMock } = vi.hoisted(() => ({
  resolveAuthMock: vi.fn(),
  resolveTriageSkillMock: vi.fn(),
}))

vi.mock('../lib/auth-helpers', () => ({
  resolveAuth: () => resolveAuthMock(),
}))

vi.mock('../lib/triage-dispatch', () => ({
  resolveTriageSkill: (...args: unknown[]) => resolveTriageSkillMock(...args),
  GENERIC_SKILL_ID: 'generic-alert-triage',
}))

beforeEach(() => {
  resolveAuthMock.mockReset()
  resolveTriageSkillMock.mockReset()
  resolveAuthMock.mockResolvedValue({
    ownerId: 'admin-id',
    name: 'admin@example.com',
    role: 'admin',
    provider: 'entra-id',
  })
})

afterEach(() => {
  vi.resetModules()
})

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/triage-mappings/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/triage-mappings/test', () => {
  it('returns 403 for reader role', async () => {
    resolveAuthMock.mockResolvedValue({
      ownerId: 'reader-id',
      name: 'reader@example.com',
      role: 'reader',
      provider: 'entra-id',
    })
    const { POST } = await import('../app/api/triage-mappings/test/route')
    const res = await POST(makeReq({ product: 'DefenderXDR', alertType: 'Foo' }) as never)
    expect(res.status).toBe(403)
  })

  it('tags a configured mapping as "mapped"', async () => {
    resolveTriageSkillMock.mockResolvedValue({
      skillId: 'defender-endpoint-triage',
      skill: { id: 'defender-endpoint-triage' },
    })
    const { POST } = await import('../app/api/triage-mappings/test/route')
    const res = await POST(
      makeReq({ product: 'DefenderXDR', alertType: 'DefenderEndpoint.SuspiciousProcess' }) as never,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ skillId: 'defender-endpoint-triage', source: 'mapped' })
  })

  it('tags the generic fallback as "generic"', async () => {
    resolveTriageSkillMock.mockResolvedValue({
      skillId: 'generic-alert-triage',
      skill: { id: 'generic-alert-triage' },
    })
    const { POST } = await import('../app/api/triage-mappings/test/route')
    const res = await POST(makeReq({ product: 'Sentinel', alertType: 'Anything' }) as never)
    const body = await res.json()
    expect(body).toEqual({ skillId: 'generic-alert-triage', source: 'generic' })
  })

  it('tags a no-skill-registered case as "none"', async () => {
    resolveTriageSkillMock.mockResolvedValue(null)
    const { POST } = await import('../app/api/triage-mappings/test/route')
    const res = await POST(makeReq({ product: 'Sentinel', alertType: 'Anything' }) as never)
    const body = await res.json()
    expect(body).toEqual({ skillId: null, source: 'none' })
  })

  it('returns 400 when product is missing', async () => {
    const { POST } = await import('../app/api/triage-mappings/test/route')
    const res = await POST(makeReq({ alertType: 'Foo' }) as never)
    expect(res.status).toBe(400)
  })

  it('returns 400 when alertType is missing', async () => {
    const { POST } = await import('../app/api/triage-mappings/test/route')
    const res = await POST(makeReq({ product: 'DefenderXDR' }) as never)
    expect(res.status).toBe(400)
  })
})

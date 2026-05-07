import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Route-handler tests for the triage-mappings CRUD surface. Pin:
//   - admin-role gate (401 unauth, 403 reader)
//   - validateMappingKey rejection (400)
//   - unknown skill ID rejection (400)
//   - duplicate-create rejection (409)
//   - triage_mapping_modified audit-event shape and metadata cleanliness

const {
  loggerMocks,
  resolveAuthMock,
  getSkillMock,
  getMappingMock,
  createMappingMock,
  updateMappingMock,
  deleteMappingMock,
  getAllMappingsMock,
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
    getMappingMock: vi.fn(),
    createMappingMock: vi.fn(),
    updateMappingMock: vi.fn(),
    deleteMappingMock: vi.fn(),
    getAllMappingsMock: vi.fn(),
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

vi.mock('../lib/skill-store', () => ({
  getSkill: (...args: unknown[]) => getSkillMock(...args),
}))

vi.mock('../lib/triage-mapping-store', async () => {
  const actual = await vi.importActual<typeof import('../lib/triage-mapping-store')>(
    '../lib/triage-mapping-store',
  )
  return {
    // Keep validateMappingKey real so the routes' early-return checks
    // exercise the same shape rules that production does.
    validateMappingKey: actual.validateMappingKey,
    getAllMappings: (...args: unknown[]) => getAllMappingsMock(...args),
    getMapping: (...args: unknown[]) => getMappingMock(...args),
    createMapping: (...args: unknown[]) => createMappingMock(...args),
    updateMapping: (...args: unknown[]) => updateMappingMock(...args),
    deleteMapping: (...args: unknown[]) => deleteMappingMock(...args),
  }
})

const TEST_OWNER_ID = '11111111-2222-3333-4444-555555555555'
const TEST_UPN = 'alice@example.com'
const VALID_KEY = 'DefenderXDR:DefenderEndpoint.SuspiciousProcess'
const VALID_SKILL_ID = 'defender-endpoint-triage'

beforeEach(() => {
  Object.values(loggerMocks).forEach((m) => {
    if (typeof m === 'function' && 'mockReset' in m) (m as { mockReset: () => void }).mockReset()
  })
  resolveAuthMock.mockReset()
  getSkillMock.mockReset()
  getMappingMock.mockReset()
  createMappingMock.mockReset()
  updateMappingMock.mockReset()
  deleteMappingMock.mockReset()
  getAllMappingsMock.mockReset()

  resolveAuthMock.mockResolvedValue({
    ownerId: TEST_OWNER_ID,
    name: TEST_UPN,
    role: 'admin',
    provider: 'entra-id',
  })
})

afterEach(() => {
  vi.resetModules()
})

// ── GET /api/triage-mappings ─────────────────────────────────

describe('GET /api/triage-mappings', () => {
  it('returns 401 when unauthenticated', async () => {
    resolveAuthMock.mockResolvedValue(null)
    const { GET } = await import('../app/api/triage-mappings/route')
    const req = new Request('http://localhost/api/triage-mappings')
    const res = await GET(req as unknown as Parameters<typeof GET>[0])
    expect(res.status).toBe(401)
  })

  it('returns 403 for reader role', async () => {
    resolveAuthMock.mockResolvedValue({
      ownerId: TEST_OWNER_ID,
      name: TEST_UPN,
      role: 'reader',
      provider: 'entra-id',
    })
    const { GET } = await import('../app/api/triage-mappings/route')
    const req = new Request('http://localhost/api/triage-mappings')
    const res = await GET(req as unknown as Parameters<typeof GET>[0])
    expect(res.status).toBe(403)
  })

  it('returns the mappings list for admins', async () => {
    getAllMappingsMock.mockResolvedValue([
      { id: VALID_KEY, skillId: VALID_SKILL_ID, updatedAt: '2026-05-07T00:00:00.000Z', updatedBy: 'x' },
    ])
    const { GET } = await import('../app/api/triage-mappings/route')
    const req = new Request('http://localhost/api/triage-mappings')
    const res = await GET(req as unknown as Parameters<typeof GET>[0])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mappings).toHaveLength(1)
    expect(body.mappings[0].id).toBe(VALID_KEY)
  })
})

// ── POST /api/triage-mappings ────────────────────────────────

describe('POST /api/triage-mappings', () => {
  function makeReq(body: unknown): Request {
    return new Request('http://localhost/api/triage-mappings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('returns 403 for reader role', async () => {
    resolveAuthMock.mockResolvedValue({
      ownerId: TEST_OWNER_ID,
      name: TEST_UPN,
      role: 'reader',
      provider: 'entra-id',
    })
    const { POST } = await import('../app/api/triage-mappings/route')
    const res = await POST(makeReq({ key: VALID_KEY, skillId: VALID_SKILL_ID }) as never)
    expect(res.status).toBe(403)
    expect(createMappingMock).not.toHaveBeenCalled()
  })

  it('returns 400 when key is missing', async () => {
    const { POST } = await import('../app/api/triage-mappings/route')
    const res = await POST(makeReq({ skillId: VALID_SKILL_ID }) as never)
    expect(res.status).toBe(400)
  })

  it('returns 400 when skillId is missing', async () => {
    const { POST } = await import('../app/api/triage-mappings/route')
    const res = await POST(makeReq({ key: VALID_KEY }) as never)
    expect(res.status).toBe(400)
  })

  it('returns 400 when the key shape is invalid', async () => {
    const { POST } = await import('../app/api/triage-mappings/route')
    const res = await POST(makeReq({ key: 'no-colon-here', skillId: VALID_SKILL_ID }) as never)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/separator/)
  })

  it("returns 400 when the skillId doesn't resolve to a registered skill", async () => {
    getSkillMock.mockResolvedValue(undefined)
    const { POST } = await import('../app/api/triage-mappings/route')
    const res = await POST(makeReq({ key: VALID_KEY, skillId: 'unknown' }) as never)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/does not exist/)
  })

  it('returns 409 when a mapping for the key already exists', async () => {
    getSkillMock.mockResolvedValue({ id: VALID_SKILL_ID })
    getMappingMock.mockResolvedValue({
      id: VALID_KEY,
      skillId: VALID_SKILL_ID,
      updatedAt: '2026-05-07T00:00:00.000Z',
      updatedBy: 'x',
    })
    const { POST } = await import('../app/api/triage-mappings/route')
    const res = await POST(makeReq({ key: VALID_KEY, skillId: VALID_SKILL_ID }) as never)
    expect(res.status).toBe(409)
  })

  it('happy path: creates the mapping, emits triage_mapping_modified, returns 201', async () => {
    getSkillMock.mockResolvedValue({ id: VALID_SKILL_ID })
    getMappingMock.mockResolvedValue(undefined)
    createMappingMock.mockResolvedValue({
      id: VALID_KEY,
      skillId: VALID_SKILL_ID,
      updatedAt: '2026-05-07T00:00:00.000Z',
      updatedBy: 'hashed-admin',
    })

    const { POST } = await import('../app/api/triage-mappings/route')
    const res = await POST(makeReq({ key: VALID_KEY, skillId: VALID_SKILL_ID }) as never)

    expect(res.status).toBe(201)
    expect(createMappingMock).toHaveBeenCalledTimes(1)
    expect(loggerMocks.emitEvent).toHaveBeenCalledTimes(1)
    const [eventType, , , metadata] = loggerMocks.emitEvent.mock.calls[0]
    expect(eventType).toBe('triage_mapping_modified')
    const meta = metadata as { mappingKey?: string; action?: string; ownerIdHash?: string }
    expect(meta.mappingKey).toBe(VALID_KEY)
    expect(meta.action).toBe('create')
    // Audit metadata must not contain the raw UPN
    expect(JSON.stringify(metadata)).not.toContain(TEST_UPN)
  })
})

// ── PUT /api/triage-mappings/[key] ───────────────────────────

describe('PUT /api/triage-mappings/[key]', () => {
  function makeReq(body: unknown): Request {
    return new Request(`http://localhost/api/triage-mappings/${encodeURIComponent(VALID_KEY)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  const params = Promise.resolve({ key: encodeURIComponent(VALID_KEY) })

  it('returns 403 for reader role', async () => {
    resolveAuthMock.mockResolvedValue({
      ownerId: TEST_OWNER_ID,
      name: TEST_UPN,
      role: 'reader',
      provider: 'entra-id',
    })
    const { PUT } = await import('../app/api/triage-mappings/[key]/route')
    const res = await PUT(makeReq({ skillId: VALID_SKILL_ID }) as never, { params } as never)
    expect(res.status).toBe(403)
  })

  it('returns 404 when the mapping does not exist', async () => {
    getMappingMock.mockResolvedValue(undefined)
    const { PUT } = await import('../app/api/triage-mappings/[key]/route')
    const res = await PUT(makeReq({ skillId: VALID_SKILL_ID }) as never, { params } as never)
    expect(res.status).toBe(404)
  })

  it('happy path: updates and emits an update audit event', async () => {
    getMappingMock.mockResolvedValue({
      id: VALID_KEY,
      skillId: 'old-skill',
      updatedAt: '2026-05-07T00:00:00.000Z',
      updatedBy: 'x',
    })
    getSkillMock.mockResolvedValue({ id: VALID_SKILL_ID })
    updateMappingMock.mockResolvedValue({
      id: VALID_KEY,
      skillId: VALID_SKILL_ID,
      updatedAt: '2026-05-07T00:00:00.000Z',
      updatedBy: 'hashed-admin',
    })

    const { PUT } = await import('../app/api/triage-mappings/[key]/route')
    const res = await PUT(makeReq({ skillId: VALID_SKILL_ID }) as never, { params } as never)
    expect(res.status).toBe(200)
    expect(updateMappingMock).toHaveBeenCalledTimes(1)
    const [eventType, , , metadata] = loggerMocks.emitEvent.mock.calls[0]
    expect(eventType).toBe('triage_mapping_modified')
    expect((metadata as { action?: string }).action).toBe('update')
  })
})

// ── DELETE /api/triage-mappings/[key] ────────────────────────

describe('DELETE /api/triage-mappings/[key]', () => {
  const params = Promise.resolve({ key: encodeURIComponent(VALID_KEY) })

  it('returns 403 for reader role', async () => {
    resolveAuthMock.mockResolvedValue({
      ownerId: TEST_OWNER_ID,
      name: TEST_UPN,
      role: 'reader',
      provider: 'entra-id',
    })
    const { DELETE } = await import('../app/api/triage-mappings/[key]/route')
    const req = new Request(`http://localhost/api/triage-mappings/${encodeURIComponent(VALID_KEY)}`, {
      method: 'DELETE',
    })
    const res = await DELETE(req as never, { params } as never)
    expect(res.status).toBe(403)
  })

  it('happy path: deletes and emits a delete audit event', async () => {
    deleteMappingMock.mockResolvedValue(undefined)
    const { DELETE } = await import('../app/api/triage-mappings/[key]/route')
    const req = new Request(`http://localhost/api/triage-mappings/${encodeURIComponent(VALID_KEY)}`, {
      method: 'DELETE',
    })
    const res = await DELETE(req as never, { params } as never)
    expect(res.status).toBe(200)
    expect(deleteMappingMock).toHaveBeenCalledWith(VALID_KEY)
    const [eventType, , , metadata] = loggerMocks.emitEvent.mock.calls[0]
    expect(eventType).toBe('triage_mapping_modified')
    expect((metadata as { action?: string }).action).toBe('delete')
  })
})

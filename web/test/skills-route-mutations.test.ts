import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Route-handler tests for the skills mutation surface. Pin:
//   - admin-role gate
//   - validateSkillId / validateSkillContent rejection
//   - injection-scan integration (monitor mode = log + proceed,
//     block mode = 400)
//   - skill_modified audit-event shape
//   - audit metadata cleanliness (no raw UPN)

const {
  loggerMocks,
  resolveAuthMock,
  createSkillMock,
  updateSkillMock,
  deleteSkillMock,
  getSkillMock,
  scanUserInputMock,
  shouldBlockMock,
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
    createSkillMock: vi.fn(),
    updateSkillMock: vi.fn(),
    deleteSkillMock: vi.fn(),
    getSkillMock: vi.fn(),
    scanUserInputMock: vi.fn(),
    shouldBlockMock: vi.fn(),
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

vi.mock('../lib/injection-guard', () => ({
  scanUserInput: (...args: unknown[]) => scanUserInputMock(...args),
  shouldBlock: (...args: unknown[]) => shouldBlockMock(...args),
}))

vi.mock('../lib/skill-store', async () => {
  const actual = await vi.importActual<typeof import('../lib/skill-store')>('../lib/skill-store')
  return {
    // Keep the validators + parser real so the routes' early-return
    // checks behave as in production.
    ...actual,
    createSkill: (...args: unknown[]) => createSkillMock(...args),
    updateSkill: (...args: unknown[]) => updateSkillMock(...args),
    deleteSkill: (...args: unknown[]) => deleteSkillMock(...args),
    getSkill: (...args: unknown[]) => getSkillMock(...args),
    getSkillsForRole: vi.fn(async () => []),
  }
})

const TEST_OWNER_ID = '11111111-2222-3333-4444-555555555555'
const TEST_UPN = 'alice@example.com'

const VALID_SKILL_MARKDOWN = [
  '# Skill: Test',
  '',
  '## Description',
  'demo',
  '',
  '## Required Tools',
  '- run_sentinel_kql',
  '',
  '## Required Role',
  'reader',
  '',
  '## Steps',
  'do the thing',
].join('\n')

beforeEach(() => {
  loggerMocks.info.mockReset()
  loggerMocks.warn.mockReset()
  loggerMocks.error.mockReset()
  loggerMocks.emitEvent.mockReset()
  resolveAuthMock.mockReset()
  createSkillMock.mockReset()
  updateSkillMock.mockReset()
  deleteSkillMock.mockReset()
  getSkillMock.mockReset()
  scanUserInputMock.mockReset()
  shouldBlockMock.mockReset()

  resolveAuthMock.mockResolvedValue({
    ownerId: TEST_OWNER_ID,
    name: TEST_UPN,
    role: 'admin',
    provider: 'entra-id',
  })
  // Default: no scan flag, no block.
  scanUserInputMock.mockReturnValue({ flagged: false, matchCount: 0, label: 'none' })
  shouldBlockMock.mockReturnValue(false)
})

afterEach(() => {
  vi.resetModules()
})

describe('POST /api/skills — admin gate', () => {
  it('returns 403 for reader role', async () => {
    resolveAuthMock.mockResolvedValue({
      ownerId: TEST_OWNER_ID,
      name: TEST_UPN,
      role: 'reader',
      provider: 'entra-id',
    })
    const { POST } = await import('../app/api/skills/route')
    const req = new Request('http://localhost/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'x-skill', content: VALID_SKILL_MARKDOWN }),
    })
    const res = await POST(req as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(403)
    expect(createSkillMock).not.toHaveBeenCalled()
  })

  it('returns 403 for triage role', async () => {
    resolveAuthMock.mockResolvedValue({
      ownerId: TEST_OWNER_ID,
      name: TEST_UPN,
      role: 'triage',
      provider: 'entra-id',
    })
    const { POST } = await import('../app/api/skills/route')
    const req = new Request('http://localhost/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'x-skill', content: VALID_SKILL_MARKDOWN }),
    })
    const res = await POST(req as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(403)
  })
})

describe('POST /api/skills — happy path', () => {
  it('emits skill_modified event with hashed ownerId and no raw UPN', async () => {
    getSkillMock.mockResolvedValue(undefined)
    createSkillMock.mockResolvedValue({
      id: 'x-skill',
      name: 'Test',
      description: 'demo',
      instructions: '',
      requiredTools: ['run_sentinel_kql'],
      requiredRole: 'reader',
      parameters: [],
    })

    const { POST } = await import('../app/api/skills/route')
    const req = new Request('http://localhost/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'x-skill', content: VALID_SKILL_MARKDOWN }),
    })
    const res = await POST(req as unknown as Parameters<typeof POST>[0])

    expect(res.status).toBe(201)
    expect(loggerMocks.emitEvent).toHaveBeenCalledTimes(1)
    const [eventType, , , metadata] = loggerMocks.emitEvent.mock.calls[0]
    expect(eventType).toBe('skill_modified')
    expect(metadata).toMatchObject({
      skillId: 'x-skill',
      action: 'create',
      role: 'admin',
    })
    expect(metadata.ownerIdHash).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(metadata)).not.toContain(TEST_UPN)
  })

  it('runs the injection scan against the content', async () => {
    getSkillMock.mockResolvedValue(undefined)
    createSkillMock.mockResolvedValue({
      id: 'x-skill',
      name: 'Test',
      description: 'demo',
      instructions: '',
      requiredTools: [],
      requiredRole: 'reader',
      parameters: [],
    })

    const { POST } = await import('../app/api/skills/route')
    const req = new Request('http://localhost/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'x-skill', content: VALID_SKILL_MARKDOWN }),
    })
    await POST(req as unknown as Parameters<typeof POST>[0])

    expect(scanUserInputMock).toHaveBeenCalledTimes(1)
    expect(scanUserInputMock).toHaveBeenCalledWith(
      VALID_SKILL_MARKDOWN,
      expect.objectContaining({ sessionId: 'skill-write', userId: TEST_OWNER_ID, role: 'admin' }),
    )
  })

  it('returns 400 when shouldBlock(scanResult) is true (block mode)', async () => {
    getSkillMock.mockResolvedValue(undefined)
    scanUserInputMock.mockReturnValue({ flagged: true, matchCount: 3, label: 'override' })
    shouldBlockMock.mockReturnValue(true)

    const { POST } = await import('../app/api/skills/route')
    const req = new Request('http://localhost/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'x-skill', content: VALID_SKILL_MARKDOWN }),
    })
    const res = await POST(req as unknown as Parameters<typeof POST>[0])

    expect(res.status).toBe(400)
    expect(createSkillMock).not.toHaveBeenCalled()
    expect(loggerMocks.emitEvent).not.toHaveBeenCalled()
  })

  it('proceeds when scan flagged but shouldBlock=false (monitor mode)', async () => {
    getSkillMock.mockResolvedValue(undefined)
    createSkillMock.mockResolvedValue({
      id: 'x-skill',
      name: 'Test',
      description: 'demo',
      instructions: '',
      requiredTools: [],
      requiredRole: 'reader',
      parameters: [],
    })
    scanUserInputMock.mockReturnValue({ flagged: true, matchCount: 1, label: 'override' })
    shouldBlockMock.mockReturnValue(false)

    const { POST } = await import('../app/api/skills/route')
    const req = new Request('http://localhost/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'x-skill', content: VALID_SKILL_MARKDOWN }),
    })
    const res = await POST(req as unknown as Parameters<typeof POST>[0])

    expect(res.status).toBe(201)
    expect(createSkillMock).toHaveBeenCalledOnce()
    expect(loggerMocks.emitEvent).toHaveBeenCalledTimes(1)
  })

  it('returns 409 on duplicate id without invoking the create path', async () => {
    getSkillMock.mockResolvedValue({
      id: 'x-skill',
      name: '',
      description: '',
      instructions: '',
      requiredTools: [],
      requiredRole: 'reader',
      parameters: [],
    })

    const { POST } = await import('../app/api/skills/route')
    const req = new Request('http://localhost/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'x-skill', content: VALID_SKILL_MARKDOWN }),
    })
    const res = await POST(req as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(409)
    expect(createSkillMock).not.toHaveBeenCalled()
  })

  it('returns 400 with the validateSkillId message for invalid ids', async () => {
    const { POST } = await import('../app/api/skills/route')
    const req = new Request('http://localhost/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'BadId', content: VALID_SKILL_MARKDOWN }),
    })
    const res = await POST(req as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toMatch(/lowercase alphanumeric/i)
  })
})

describe('PUT /api/skills/[id]', () => {
  it('returns 403 for non-admin', async () => {
    resolveAuthMock.mockResolvedValue({
      ownerId: TEST_OWNER_ID,
      name: TEST_UPN,
      role: 'reader',
      provider: 'entra-id',
    })
    const { PUT } = await import('../app/api/skills/[id]/route')
    const req = new Request('http://localhost/api/skills/x-skill', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: VALID_SKILL_MARKDOWN }),
    })
    const res = await PUT(req as unknown as Parameters<typeof PUT>[0], {
      params: Promise.resolve({ id: 'x-skill' }),
    })
    expect(res.status).toBe(403)
    expect(updateSkillMock).not.toHaveBeenCalled()
  })

  it('emits skill_modified action: update', async () => {
    getSkillMock.mockResolvedValue({
      id: 'x-skill',
      name: '',
      description: '',
      instructions: '',
      requiredTools: [],
      requiredRole: 'reader',
      parameters: [],
    })
    updateSkillMock.mockResolvedValue({
      id: 'x-skill',
      name: 'T',
      description: 'd',
      instructions: '',
      requiredTools: [],
      requiredRole: 'reader',
      parameters: [],
    })

    const { PUT } = await import('../app/api/skills/[id]/route')
    const req = new Request('http://localhost/api/skills/x-skill', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: VALID_SKILL_MARKDOWN }),
    })
    const res = await PUT(req as unknown as Parameters<typeof PUT>[0], {
      params: Promise.resolve({ id: 'x-skill' }),
    })
    expect(res.status).toBe(200)
    expect(loggerMocks.emitEvent).toHaveBeenCalledTimes(1)
    const [eventType, , , metadata] = loggerMocks.emitEvent.mock.calls[0]
    expect(eventType).toBe('skill_modified')
    expect(metadata.action).toBe('update')
    expect(metadata.skillId).toBe('x-skill')
  })
})

describe('DELETE /api/skills/[id]', () => {
  it('returns 403 for non-admin', async () => {
    resolveAuthMock.mockResolvedValue({
      ownerId: TEST_OWNER_ID,
      name: TEST_UPN,
      role: 'reader',
      provider: 'entra-id',
    })
    const { DELETE } = await import('../app/api/skills/[id]/route')
    const req = new Request('http://localhost/api/skills/x-skill', { method: 'DELETE' })
    const res = await DELETE(req as unknown as Parameters<typeof DELETE>[0], {
      params: Promise.resolve({ id: 'x-skill' }),
    })
    expect(res.status).toBe(403)
    expect(deleteSkillMock).not.toHaveBeenCalled()
  })

  it('emits skill_modified action: delete on success', async () => {
    getSkillMock.mockResolvedValue({
      id: 'x-skill',
      name: '',
      description: '',
      instructions: '',
      requiredTools: [],
      requiredRole: 'reader',
      parameters: [],
    })
    deleteSkillMock.mockResolvedValue(undefined)

    const { DELETE } = await import('../app/api/skills/[id]/route')
    const req = new Request('http://localhost/api/skills/x-skill', { method: 'DELETE' })
    const res = await DELETE(req as unknown as Parameters<typeof DELETE>[0], {
      params: Promise.resolve({ id: 'x-skill' }),
    })
    expect(res.status).toBe(200)
    expect(loggerMocks.emitEvent).toHaveBeenCalledTimes(1)
    const [eventType, , , metadata] = loggerMocks.emitEvent.mock.calls[0]
    expect(eventType).toBe('skill_modified')
    expect(metadata.action).toBe('delete')
    expect(metadata.skillId).toBe('x-skill')
    expect(metadata.ownerIdHash).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(metadata)).not.toContain(TEST_UPN)
  })
})

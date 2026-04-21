import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  resolveMaxTokens,
  __resetResolveMaxTokensWarnings,
  MAX_TOKENS_DEFAULT,
  MAX_TOKENS_SKILL,
  MODEL_OUTPUT_CEILINGS,
} from '../lib/config'

describe('resolveMaxTokens', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    __resetResolveMaxTokensWarnings()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('returns MAX_TOKENS_DEFAULT for a plain chat turn on a spacious model', () => {
    const out = resolveMaxTokens('claude-sonnet-4-6', { skillInvocation: false })
    expect(out).toBe(Math.min(MAX_TOKENS_DEFAULT, MODEL_OUTPUT_CEILINGS['claude-sonnet-4-6']))
  })

  it('returns MAX_TOKENS_SKILL for a skill turn on a spacious model', () => {
    const out = resolveMaxTokens('claude-sonnet-4-6', { skillInvocation: true })
    expect(out).toBe(Math.min(MAX_TOKENS_SKILL, MODEL_OUTPUT_CEILINGS['claude-sonnet-4-6']))
  })

  it('clamps to the model ceiling when the requested budget exceeds it', () => {
    // Haiku 4.5 has the smallest ceiling in the map at 8192.
    const haikuCeiling = MODEL_OUTPUT_CEILINGS['claude-haiku-4-5-20251001']
    expect(MAX_TOKENS_SKILL).toBeGreaterThan(haikuCeiling)
    const out = resolveMaxTokens('claude-haiku-4-5-20251001', { skillInvocation: true })
    expect(out).toBe(haikuCeiling)
  })

  it('warns once per model id when the budget is clamped to the ceiling', () => {
    resolveMaxTokens('claude-haiku-4-5-20251001', { skillInvocation: true })
    resolveMaxTokens('claude-haiku-4-5-20251001', { skillInvocation: true })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('claude-haiku-4-5-20251001')
  })

  it('falls back to the requested value for an unknown model (no ceiling in the map)', () => {
    // The skill budget fits comfortably below any real ceiling; for an
    // unknown model we have no ceiling info so we pass the requested
    // value through unchanged.
    const out = resolveMaxTokens('some-future-model-xyz', { skillInvocation: true })
    expect(out).toBe(MAX_TOKENS_SKILL)
  })
})

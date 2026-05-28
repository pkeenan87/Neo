import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  resolveMaxTokens,
  __resetResolveMaxTokensWarnings,
  MAX_TOKENS_DEFAULT,
  MAX_TOKENS_SKILL,
  MODEL_OUTPUT_CEILINGS,
  TOKEN_PRICING,
  SUPPORTED_MODELS,
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

// Regression guards added after a long publisher-analysis response was
// truncated mid-output because MAX_TOKENS_DEFAULT was 4096 (way below
// the Opus 4.7 / Sonnet 4.6 output ceilings). Pricing entries were
// also missing for claude-opus-4-7 and its 1M-context variant, which
// silently zero-costed those turns in usage-tracker.
describe('config invariants (post output-budget review)', () => {
  it('MAX_TOKENS_DEFAULT is at least 16K so multi-page responses do not truncate', () => {
    expect(MAX_TOKENS_DEFAULT).toBeGreaterThanOrEqual(16_384)
  })

  it('every model in MODEL_OUTPUT_CEILINGS has a matching TOKEN_PRICING entry', () => {
    // Drift between these two maps causes usage-tracker to silently
    // bill 0 for any model present in CEILINGS but missing from PRICING.
    const ceilingModels = Object.keys(MODEL_OUTPUT_CEILINGS).sort()
    const missing = ceilingModels.filter((m) => !TOKEN_PRICING[m])
    expect(missing).toEqual([])
  })

  it('claude-opus-4-7 and claude-opus-4-7[1m] both have pricing entries', () => {
    expect(TOKEN_PRICING['claude-opus-4-7']).toBeDefined()
    expect(TOKEN_PRICING['claude-opus-4-7[1m]']).toBeDefined()
  })

  it('the 1M-context Opus tier is priced at 2x the standard tier', () => {
    const std = TOKEN_PRICING['claude-opus-4-7']
    const tier1m = TOKEN_PRICING['claude-opus-4-7[1m]']
    expect(tier1m.input).toBe(std.input * 2)
    expect(tier1m.output).toBe(std.output * 2)
  })

  it('every value in SUPPORTED_MODELS has matching CEILING and PRICING entries', () => {
    // Drift gap: a model surfaced in the selector / API but missing
    // from MODEL_OUTPUT_CEILINGS silently falls through resolveMaxTokens
    // to MAX_TOKENS_DEFAULT without clamping. Missing from TOKEN_PRICING
    // zero-costs the user's usage. Both maps must contain every value
    // in SUPPORTED_MODELS. See ultra-review F10.
    const ids = Object.values(SUPPORTED_MODELS).sort()
    const missingCeiling = ids.filter((m) => MODEL_OUTPUT_CEILINGS[m] === undefined)
    const missingPricing = ids.filter((m) => TOKEN_PRICING[m] === undefined)
    expect(missingCeiling).toEqual([])
    expect(missingPricing).toEqual([])
  })
})

/**
 * Parse an environment variable as a positive integer, falling back to
 * `defaultValue` when the var is missing, empty, non-numeric, or <= 0.
 *
 * Extracted to a standalone module (no transitive imports) so it can be
 * imported by both config.ts and the test suite.
 */
export function parsePositiveInt(envVar: string, defaultValue: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    // Note: console.warn (not logger) because logger imports config → circular dep.
    console.warn(
      `${envVar} has invalid value "${raw}" — falling back to default (${defaultValue}).`,
    );
    return defaultValue;
  }
  return parsed;
}

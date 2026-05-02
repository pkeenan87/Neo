// Flat ESLint config for the web project.
//
// Baseline only — the goal of this initial config is to make the
// project's existing TypeScript discipline (zero `any` in source per
// the 2026-05-02 audit) machine-enforceable, not to introduce a wave
// of style nits. Style/format rules can layer on later.

import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "dist/**",
      "public/**",
      "next-env.d.ts",
      "tsconfig.tsbuildinfo",
      "scripts/**",
      // Spec / plan / docs are markdown but tooling sometimes scans
      // adjacent code-fenced blocks; keep them out of scope here.
      "../_specs/**",
      "../_plans/**",
    ],
  },

  ...tseslint.configs.recommended,

  // React-hooks rules only fire in directories that actually carry
  // React components / custom hooks. The `use*` naming convention is
  // also used by server-side helpers in `lib/` (skill-store, teams-
  // session-map, etc.) and we don't want false positives there.
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "hooks/**/*.{ts,tsx}", "context/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  {
    rules: {
      // Forbid `any` per CLAUDE.md and the audit. Use `unknown` and narrow.
      "@typescript-eslint/no-explicit-any": "error",

      // Allow underscore-prefixed unused identifiers (parameters, captures).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],

      // The codebase uses `as unknown as T` deliberately at SDK / Cosmos
      // boundaries (see executors.ts dispatch table) — don't flag those.
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-empty-object-type": "off",

      // Allow `require` inside the migrate scripts' banner shim.
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  // Tests get looser rules — vitest mocks legitimately need `any`-shaped
  // values and unused imports for setup-side-effects.
  {
    files: ["test/**/*.{ts,tsx,js}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },

  // No `console.log` in UI surfaces (app/, components/). lib/ keeps
  // legitimate raw-console usage in `validateConfig`, the Event Hub
  // fallback path, and similar bootstrap-time observability sites.
  // `console.warn` and `console.error` remain allowed for visible
  // error reporting; `console.log` is the noisy one.
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
);

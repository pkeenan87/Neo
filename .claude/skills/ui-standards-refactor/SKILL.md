---
name: ui-standards-refactor
description: Refactor v0 (Vercel), Vite component, or Figma Dev Mode output into production-grade Next.js + TypeScript components that conform to the project design system. Use this skill whenever the user pastes v0-generated code, Figma Dev Mode output, or any raw component that needs to be brought into compliance. Also trigger for any request that involves applying design tokens, enforcing the 3-class inline rule, converting inline Tailwind classes to CSS modules, adding hover states, fixing shadcn/ui imports, replacing generic Tailwind colors with brand tokens, adding TypeScript interfaces, or setting up barrel exports. This is the primary skill for all frontend component work in this Next.js project.
---

# UI Standards Refactor Skill

Refactor v0, Vite, or Figma Dev Mode output into clean, typed Next.js components that conform to the design system in `references/design-tokens.md`. This skill governs **all** styling, component structure, and export decisions regardless of where the component originated.

> **First step on every task**: Read `references/design-tokens.md` to load the active color palette, typography scale, spacing scale, and shadow tokens before writing a single line of code.

---

## Core Rules (Non-Negotiable)

### 1. The 3-Class Inline Rule

**Maximum 3 Tailwind classes may appear on any single JSX element inline.**

When a fourth class would be needed, extract ALL classes for that element into a CSS Module utility class instead.

```tsx
// ✅ GOOD — 3 or fewer inline classes
<div className="flex items-center gap-4">

// ✅ GOOD — 4+ classes extracted to CSS module
<div className={styles.cardWrapper}>

// ❌ BAD — 4+ inline classes
<div className="flex items-center gap-4 rounded-xl bg-white shadow-md px-6 py-4">
```

**The threshold is per-element, not per-file.** A simple wrapper with only `flex flex-col` stays inline. A card with layout + color + spacing + radius + shadow goes to a module class.

### 2. CSS Module Utility Class Rules

- File lives at `ComponentName.module.css` alongside the component
- Class names use **camelCase** describing the element's role: `.cardWrapper`, `.primaryButton`, `.heroHeading`
- Never name classes by their visual properties: `.flexRow` or `.bgWhite` are wrong; `.navContainer` or `.sectionHeader` are right
- Tailwind classes inside CSS modules use `@apply`:

```css
/* ComponentName.module.css */
.cardWrapper {
  @apply flex flex-col rounded-xl bg-white shadow-card px-6 py-5 gap-3;
}

.cardWrapper:hover {
  @apply shadow-card-hover bg-neutral-50;
}
```

- CSS modules may also contain **non-Tailwind CSS** for things Tailwind can't express (complex `clip-path`, `grid-template-areas`, custom transitions with bezier curves).

### 3. Hover State / Tint-Shade Pattern

Hover effects always step **one shade level** in the appropriate direction. For the full shade map see `references/design-tokens.md`.

```css
/* Elevation pattern for light backgrounds */
.primaryButton {
  @apply bg-brand-600 text-white transition-colors duration-150;
}
.primaryButton:hover {
  @apply bg-brand-700; /* one step darker */
}

/* Lift pattern for cards/surfaces */
.card {
  @apply bg-white shadow-card transition-shadow duration-150;
}
.card:hover {
  @apply shadow-card-hover; /* elevated shadow token */
}

/* Subtle fill for ghost/text elements */
.ghostButton {
  @apply text-brand-600 bg-transparent transition-colors duration-150;
}
.ghostButton:hover {
  @apply bg-brand-50; /* lightest tint as fill */
}
```

**Never use opacity hacks for hover states** (`hover:opacity-80`). Always use the explicit shade token.

---

## Component Structure

Every component follows this exact file layout:

```
components/
  ComponentName/
    ComponentName.tsx       ← component + TypeScript interface
    ComponentName.module.css ← CSS module (only if 4+ classes needed anywhere)
    index.ts                ← barrel export
```

### ComponentName.tsx template

```tsx
import styles from './ComponentName.module.css'

interface ComponentNameProps {
  // typed props — never use `any`
  children?: React.ReactNode
  variant?: 'primary' | 'secondary' | 'ghost'
  className?: string  // always accept className for composability
}

export function ComponentName({
  children,
  variant = 'primary',
  className,
}: ComponentNameProps) {
  return (
    <div className={`${styles.wrapper} ${className ?? ''}`}>
      {children}
    </div>
  )
}
```

### index.ts barrel export

```ts
export { ComponentName } from './ComponentName'
export type { ComponentNameProps } from './ComponentName'  // if type is exported
```

### Page-level barrel (components/index.ts)

All components roll up to a single barrel at the components root:

```ts
// components/index.ts
export * from './Button'
export * from './Card'
export * from './NavBar'
// ... one line per component folder
```

Imports in pages/other components always use the barrel:
```tsx
import { Button, Card, NavBar } from '@/components'
```

**Never** use deep imports like `import { Button } from '@/components/Button/Button'` in consuming files.

---

## Workflow — Refactoring v0 or Figma Output

The primary workflow is **refactor, not build from scratch**. The user pastes v0-generated
code or Figma Dev Mode output and this skill brings it into compliance with all standards.

---

### Input type: v0 (Vercel)

v0 produces structurally sound JSX but with several systematic problems:

```tsx
// Typical v0 output — what's wrong is annotated
'use client'                                          // ← often unnecessary, check first
import { Button } from '@/components/ui/button'      // ← shadcn import, see Step 1
import { cn } from '@/lib/utils'                     // ← shadcn utility, see Step 1

export function PricingCard() {
  return (
    // ↓ 10 inline classes — violates 3-class rule
    <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm flex flex-col gap-4">
      // ↓ generic Tailwind color — needs brand token
      <h3 className="text-xl font-semibold text-gray-900 tracking-tight">Pro Plan</h3>
      // ↓ arbitrary value — not on T-shirt scale
      <p className="text-[15px] text-gray-500">Everything you need</p>
      // ↓ generic blue — needs brand token
      <Button className="bg-blue-600 hover:bg-blue-700 text-white">Get started</Button>
    </div>
  )
}
```

---

### Input type: Figma Dev Mode

Figma Dev Mode exports raw CSS properties or inline-styled JSX:

```tsx
// Raw Figma export
<div style={{ padding: '24px', background: '#1D4ED8', borderRadius: '8px' }}>
  <p style={{ fontSize: '16px', fontWeight: 600 }}>Hello</p>
</div>
```

---

### Step 1 — Decide how to handle shadcn/ui (v0 only)

v0 uses shadcn/ui primitives (`Button`, `Card`, `Input`, `Badge`, etc.). Before refactoring,
determine which path to take based on what the user has said or the project context:

**Keep shadcn** — If the project already has shadcn/ui installed, keep the primitive
imports but restyle usage: remove hardcoded `className` overrides on shadcn components
and instead use variant props where they exist. Remap any color overrides to brand tokens.

**Replace with custom** — If the project does not use shadcn/ui, rebuild the component
using the canonical patterns in `references/component-patterns.md`. Shadcn `Button`
becomes the custom `Button` component; shadcn `Card` becomes the custom `Card`, etc.

If unsure, **ask the user once** before proceeding: "This uses shadcn/ui components —
do you have it installed, or should I replace them with custom components?"

The `cn()` utility from shadcn should be removed in either path. Use template literals
(`\`\${styles.base} \${className ?? ''}\``) instead.

---

### Step 2 — Remap colors to brand tokens

**From v0 (generic Tailwind colors → brand tokens):**

v0 picks colors from Tailwind's default palette. Map them to your tokens based on intent,
not on exact hue match.

| v0 uses | Maps to | Reasoning |
|---|---|---|
| `bg-blue-*` / `bg-indigo-*` | `bg-brand-*` (same shade number) | Primary color family |
| `bg-white` | `bg-surface-raised` | Card / panel background |
| `bg-gray-50` | `bg-surface-default` | Page background |
| `bg-gray-100` | `bg-surface-sunken` | Input / sunken background |
| `text-gray-900` | `text-neutral-900` | Primary text |
| `text-gray-600` | `text-neutral-600` | Secondary text |
| `text-gray-400` | `text-neutral-400` | Placeholder / disabled |
| `border-gray-200` | `border-border-default` | Default border |
| `border-gray-300` | `border-border-strong` | Strong / focus border |
| `text-blue-*` / `text-indigo-*` | `text-brand-*` (same shade number) | Brand text |
| Arbitrary `text-[#hex]` | Match hex to nearest brand/neutral token | |

**From Figma Dev Mode (raw hex → brand tokens):**

| Figma value | Map to |
|---|---|
| Exact hex match in design-tokens.md | Use that token directly |
| Close to a brand shade | Nearest `brand-NNN`; note deviation in a comment |
| Close to a neutral shade | Nearest `neutral-NNN` |
| White or near-white background | `surface-raised` or `surface-default` |
| Light input/field background | `surface-sunken` |
| No close match | Flag it — ask if it should be added as a new token |

---

### Step 3 — Snap spacing to the 8pt grid

| Raw value | Tailwind | Note |
|---|---|---|
| 4px / 0.25rem | `p-1` | micro-exception — add comment |
| 8px / 0.5rem | `p-2` | |
| 16px / 1rem | `p-4` | |
| 24px / 1.5rem | `p-8` | snapped up to 2rem |
| 32px / 2rem | `p-8` | |
| 48px / 3rem | `p-16` | snapped up to 4rem |
| 64px / 4rem | `p-16` | |

---

### Step 4 — Snap font sizes to T-shirt scale

| Raw value | Tailwind |
|---|---|
| 12px / 0.75rem | `text-xs` |
| 14px / 0.875rem | `text-sm` |
| 16px / 1rem | `text-base` |
| 18px / 1.125rem | `text-lg` |
| 20px / 1.25rem | `text-xl` |
| 24px / 1.5rem | `text-2xl` |
| 30px / 1.875rem | `text-3xl` |
| 36px / 2.25rem | `text-4xl` |

Replace all `font-sans` with `font-body` and all heading font families with `font-display`.
Remove arbitrary font size values (`text-[15px]`) — snap to nearest T-shirt size.

---

### Step 5 — Apply the 3-class rule

Count the Tailwind classes on each element after token substitution and spacing/font snapping:
- ≤ 3 classes → stays inline as `className="..."`
- ≥ 4 classes → all classes for that element move to a named CSS module utility class

This will affect most v0 elements since v0 routinely puts 8–12 classes on a single element.

---

### Step 6 — Check the 'use client' directive

v0 adds `'use client'` by default. Remove it unless the component actually uses:
- React state (`useState`, `useReducer`)
- React effects (`useEffect`)
- Browser APIs
- Event handlers that require client interactivity

Server Components are the default in Next.js App Router. Only add `'use client'` when needed.

---

### Step 7 — Write the refactored output

Output in this order:
1. `ComponentName.tsx` — typed props, JSX with `styles.*` or ≤3 inline classes
2. `ComponentName.module.css` — `@apply` blocks for all 4+ class elements + hover states
3. `index.ts` — barrel export

---

### Step 8 — Add hover states

Neither v0 nor Figma Dev Mode exports hover states reliably. Add them automatically for
every interactive element. Do not ask the user whether to include them.

---

### Step 9 — Report what changed

After outputting the component, provide a brief change summary:

```
Changes applied:
- shadcn Button → custom Button component (variant="primary")
- bg-blue-600 → bg-brand-600, hover:bg-blue-700 → CSS module hover:bg-brand-700
- bg-gray-50 → bg-surface-default
- border-gray-200 → border-border-default
- text-gray-900 → text-neutral-900
- p-6 → p-8 (snapped 1.5rem → 2rem, 8pt grid)
- text-[15px] → text-sm (T-shirt scale)
- font-sans → font-body
- 10 inline classes on card wrapper → styles.cardWrapper (CSS module)
- Removed 'use client' (no state or browser APIs used)
- Added hover states: shadow-card-hover, brand-700
- Added TypeScript interface: PricingCardProps
- Added barrel export
```

---

## Typography Rules

The type scale uses **T-shirt sizes mapped to Tailwind** (`text-sm`, `text-base`, `text-lg`, `text-xl`, `text-2xl`, `text-3xl`, `text-4xl`). This maps directly to Tailwind's built-in scale — no custom `fontSize` tokens needed in config unless a Figma size falls between steps.

**Size → role mapping** (read from `references/design-tokens.md` for exact assignments):

| T-shirt | Tailwind | Typical role |
|---|---|---|
| xs | `text-xs` | Captions, timestamps, legal |
| sm | `text-sm` | Labels, secondary text, helper text |
| base | `text-base` | Default body copy |
| lg | `text-lg` | Emphasized body, lead paragraphs |
| xl | `text-xl` | Small headings, card titles |
| 2xl | `text-2xl` | Section headings (H3) |
| 3xl | `text-3xl` | Page headings (H2) |
| 4xl+ | `text-4xl` / `text-5xl` | Hero / display (H1) |

- **Font family**: Never use Tailwind's default `font-sans` or `font-mono` — always use the named font tokens (`font-display`, `font-body`, `font-mono`)
- **Size and weight travel together** — a heading is never just `text-3xl` without a weight (`font-semibold` / `font-bold`). A label is never `text-sm` without `font-medium`.
- **Line height follows the Tailwind pairing** — use `leading-tight` for headings (1.25), `leading-snug` for subheadings (1.375), `leading-normal` for body (1.5), `leading-relaxed` for long-form copy (1.625). Override only when the Figma spec is explicit.
- **Tracking**: `tracking-tight` for headings at 2xl and above, `tracking-normal` for everything else. Never use arbitrary tracking values.

Heading elements always use the semantic HTML element (`h1`–`h6`). Never render a heading as a `div` or `p` just to apply a class.

**3-class rule with typography**: `text-3xl font-bold leading-tight` is exactly 3 classes — that's the limit for a heading element inline. Add `font-display` or a color and it goes to a CSS module class.

---

## Spacing Rules

All spacing is on an **8pt grid** using the multiples `2 / 4 / 8 / 16 / 32` (0.5rem / 1rem / 2rem / 4rem / 8rem). These are the only permitted spacing values unless the Figma spec explicitly requires an intermediate step.

> Tailwind's spacing scale is rem-based, which means spacing respects the user's root font size preference. Never convert to px when reasoning about spacing — always use rem.

| Tailwind | rem | When to use |
|---|---|---|
| `2` | 0.5rem | Tightest component gaps (icon-to-label, badge padding) |
| `4` | 1rem | Default element padding, list item gaps |
| `8` | 2rem | Card padding, component internal sections |
| `16` | 4rem | Section vertical padding, layout gutters |
| `32` | 8rem | Hero sections, major page divisions |

**The only exceptions** to the 8pt rule:
- `p-1` / `px-1.5` / `py-0.5` for micro-padding inside badges, chips, and tight UI elements
- `gap-3` (0.75rem) when a Figma spec explicitly shows a 12px/0.75rem gap — note the deviation with a comment
- Border radius values (`rounded`, `rounded-lg`, etc.) are independent of the spacing grid

**Never use** `px-3`, `py-5`, `mt-7`, `gap-6` as primary layout spacing. When in doubt, round to the nearest 8pt step.

```tsx
// ✅ Correct 8pt grid usage
<section className="py-16 px-8">        // 4rem vertical, 2rem horizontal
<div className="flex flex-col gap-8">   // 2rem gap between cards
<div className={styles.cardBody}>       // 4+ classes → CSS module

// ❌ Off-grid
<section className="py-14 px-7">
<div className="flex flex-col gap-6">
```

---

## TypeScript Conventions

- **No `any`** — ever. Use `unknown` and narrow, or define the proper type.
- Props interfaces are always named `ComponentNameProps` and exported.
- Variant props use **union literals**, never strings: `variant: 'primary' | 'secondary'` not `variant: string`
- All optional props have explicit defaults in destructuring
- Event handler props type as React's built-ins: `onClick?: React.MouseEventHandler<HTMLButtonElement>`
- `className?: string` is always the last prop, always optional, always forwarded to the outermost element

---

## Next.js Conventions

- **App Router or Pages Router**: Check the project structure. If `app/` directory exists, use App Router patterns (Server Components by default, `'use client'` only when needed for state/events). If `pages/` exists, use Pages Router patterns.
- Images: always use `next/image` with explicit `width`/`height` or `fill` + `sizes`
- Links: always use `next/link` — never `<a>` for internal routes
- Fonts: use `next/font` — declare in `app/layout.tsx` or `pages/_app.tsx` and pass as CSS variable to Tailwind config
- Path aliases: use `@/` prefix for all imports from the project root

---

## File Naming Conventions

| Type | Convention | Example |
|---|---|---|
| Component file | PascalCase | `PrimaryButton.tsx` |
| CSS module | Match component | `PrimaryButton.module.css` |
| Barrel | lowercase | `index.ts` |
| Type-only file | `.types.ts` suffix | `Button.types.ts` |
| Hook | `use` prefix | `useModalState.ts` |
| Utility | camelCase | `formatCurrency.ts` |

---

## Common Anti-Patterns to Avoid

| Anti-pattern | Correct approach |
|---|---|
| `hover:opacity-80` for hover states | Use explicit shade token (`hover:bg-brand-700`) |
| 6+ inline Tailwind classes | Extract to CSS module utility class |
| `font-sans` / `font-mono` without config | Use named font token (`font-body`, `font-display`) |
| `text-[#3B82F6]` arbitrary color | Use design token (`text-brand-500`) |
| `bg-blue-600` generic Tailwind color | Use brand token (`bg-brand-600`) |
| `bg-gray-100` generic neutral | Use semantic token (`bg-surface-sunken`) |
| `text-[15px]` arbitrary font size | Snap to T-shirt scale (`text-sm`) |
| `cn()` from shadcn/lib/utils | Use template literals for class composition |
| `'use client'` by default (v0 habit) | Only add when component actually needs it |
| Deep component imports | Always import from barrel (`@/components`) |
| `any` type | Define proper interface or use `unknown` |
| `<a href="/page">` | Use `<Link href="/page">` |
| Hardcoded px values in Tailwind | Use the spacing scale tokens |
| Styling with `style={{}}` prop | Use Tailwind or CSS module |
| Missing CSS module file when 4+ classes used | Always create the `.module.css` file |

---

## Reference Files

- **`references/design-tokens.md`** — Active color palette, typography scale, spacing tokens, shadows. **Read this before every coding task.** This is the source of truth for all token decisions.
- **`references/component-patterns.md`** — Canonical component implementations (Card, Button, Input, Modal, NavBar, Badge). Use these as the replacement target when removing shadcn/ui primitives.
# Design Tokens

> **Theme**: Light mode is the default. Dark mode inverts the brand palette from Slate → Green.
> All tokens below reflect the **light mode** values. Dark mode overrides are noted inline where they differ.

---

## Color Palette

### Brand (Primary) — Slate Scale (Light Default)
In light mode, the brand is the **Slate** scale (slate-900 drives primary buttons, headings, icons).
In dark mode, the brand shifts to **Green** (green-500 replaces slate-900 as the dominant accent).

| Token | Hex | Tailwind Class | Usage |
|---|---|---|---|
| brand-50 | `#f8fafc` | `bg-brand-50` | Lightest tint, ghost hover fill |
| brand-100 | `#f1f5f9` | `bg-brand-100` | Light accent backgrounds, subtle borders |
| brand-200 | `#e2e8f0` | `bg-brand-200` | Dividers, default borders |
| brand-300 | `#cbd5e1` | `bg-brand-300` | Focused/active borders |
| brand-400 | `#94a3b8` | `bg-brand-400` | Placeholder text |
| brand-500 | `#64748b` | `bg-brand-500` | Default brand color, subtle body text |
| brand-600 | `#475569` | `bg-brand-600` | Secondary text |
| brand-700 | `#334155` | `bg-brand-700` | Body text |
| brand-800 | `#1e293b` | `bg-brand-800` | Headings |
| brand-900 | `#0f172a` | `bg-brand-900` | Primary buttons, high-contrast text, icons |

> **Dark mode accent override**: `green-500 (#22c55e)` replaces `brand-900` as the primary interactive color.
> Dark mode button: `bg-green-500 text-black hover:bg-green-400`
> Dark mode glow shadow: `0 0 50px rgba(34,197,94,0.1)`

### Neutral
Shares the Slate scale. This is intentional — the design uses a single monochromatic system.

| Token | Hex | Tailwind Class | Usage |
|---|---|---|---|
| neutral-50 | `#f8fafc` | `bg-neutral-50` | Page background / card hover |
| neutral-100 | `#f1f5f9` | `bg-neutral-100` | Input backgrounds, subtle section borders |
| neutral-200 | `#e2e8f0` | `bg-neutral-200` | Dividers / borders |
| neutral-300 | `#cbd5e1` | `bg-neutral-300` | Disabled borders |
| neutral-400 | `#94a3b8` | `bg-neutral-400` | Placeholder text |
| neutral-500 | `#64748b` | `bg-neutral-500` | Subtle body text |
| neutral-600 | `#475569` | `bg-neutral-600` | Secondary text (e.g. log items) |
| neutral-700 | `#334155` | `bg-neutral-700` | Body text |
| neutral-800 | `#1e293b` | `bg-neutral-800` | Headings |
| neutral-900 | `#0f172a` | `bg-neutral-900` | High-contrast text |

### Semantic Surface Tokens

| Semantic Token | Maps To | Hex | Usage |
|---|---|---|---|
| surface-default | neutral-50 | `#f8fafc` | Page/app background (`bg-slate-50`) |
| surface-raised | white | `#ffffff` | Sidebar, cards, dropdowns (`bg-white`) |
| surface-overlay | white/80 | `#ffffff` | Login card with backdrop blur (`bg-white/80`) |
| surface-sunken | neutral-100 | `#f1f5f9` | Input fields, sidebar section backgrounds |
| border-default | neutral-200 | `#e2e8f0` | Default card/sidebar borders (`border-slate-200`) |
| border-strong | neutral-100 | `#f1f5f9` | Subtle internal dividers (`border-slate-100`) |

> **Dark mode surfaces**: `surface-default` → `#1a1a1a`, `surface-raised` → `#1a1a1a/90`,
> `surface-overlay` → `#1a1a1a/80`, `border-default` → `rgba(34,197,94,0.2)` (green-500/20),
> `border-strong` → `rgba(34,197,94,0.1)` (green-500/10)

### Feedback Colors

| Token | Hex | Tailwind Equivalent | Usage |
|---|---|---|---|
| success-500 | `#22c55e` | `green-500` | Success states, dark mode primary accent |
| success-50 | `#f0fdf4` | `green-50` | Success backgrounds |
| error-500 | `#ef4444` | `red-500` | Error states, Terminate Session button |
| error-50 | `#fef2f2` | `red-50` | Error backgrounds (`hover:bg-red-500/5`) |
| warning-500 | `#f59e0b` | `amber-500` | Warning states |
| warning-50 | `#fffbeb` | `amber-50` | Warning backgrounds |

---

## Typography

### Font Families
This app uses a **single monospace font** across all roles — display, body, and code share JetBrains Mono.

| Token | Font Name | CSS Variable | Source |
|---|---|---|---|
| font-display | `JetBrains Mono` | `--font-mono` | Defined in `index.css` `@theme` block |
| font-body | `JetBrains Mono` | `--font-mono` | Applied via `font-mono` on `body` |
| font-mono | `JetBrains Mono` | `--font-mono` | Explicit code/terminal strings |

> Fallback stack: `ui-monospace, SFMono-Regular, monospace` (from `index.css`)

### Type Scale

| T-shirt | Tailwind | rem | Line Height | Weight | Tracking | Role / Usage in App |
|---|---|---|---|---|---|---|
| xs | `text-xs` | 0.75rem | `leading-normal` | `font-normal` | `tracking-normal` | Captions, timestamps |
| sm | `text-sm` | 0.875rem | `leading-normal` | `font-medium` | `tracking-normal` | Labels, chat list items, helper text |
| base | `text-base` | 1rem | `leading-normal` | `font-normal` | `tracking-normal` | Default body / chat messages |
| lg | `text-lg` | 1.125rem | `leading-snug` | `font-bold` | `tracking-widest` | Sidebar brand name "NEO" |
| xl | `text-xl` | 1.25rem | `leading-snug` | `font-semibold` | `tracking-normal` | Card titles, H4 |
| 2xl | `text-2xl` | 1.5rem | `leading-snug` | `font-semibold` | `tracking-tight` | Section sub-headings |
| 3xl | `text-3xl` | 1.875rem | `leading-tight` | `font-bold` | `tracking-tight` | Page headings |
| 4xl | `text-4xl` | 2.25rem | `leading-tight` | `font-bold` | `tracking-tight` | Hero headings |
| 5xl | `text-5xl` | 3rem | `leading-none` | `font-bold` | `tracking-[0.3em]` | App title "Neo" on login screen |

### Special Tracking Utilities Used in App

```tsx
// App-specific tracking values (used inline, too app-specific for the scale)
<span className="tracking-widest">   // sidebar "NEO", section labels
<span className="tracking-[0.3em]">  // login hero title
<span className="tracking-[0.2em]">  // SSO helper text
<span className="uppercase text-[10px] tracking-widest"> // micro-labels (Recent Logs, clearance level)
```

### Standard Typography Combos

```tsx
// Login hero
<h1 className="text-5xl font-bold tracking-[0.3em] uppercase">  // App title

// Sidebar brand
<span className="font-bold tracking-widest text-lg">             // NEO wordmark

// Micro-labels (section headers, status text)
<div className="text-[10px] uppercase tracking-widest">          // "Recent Logs", "Level 4 Clearance"

// Body / chat messages
<p className="text-sm font-mono leading-relaxed">                // Message content

// Caption / legal text
<p className="text-[9px] uppercase tracking-[0.3em]">            // Footer attribution
```

---

## Spacing Scale

**8pt grid — primary values are `2 / 4 / 8 / 16 / 32` only.**

| Tailwind | rem | Purpose / App Usage |
|---|---|---|
| `2` | 0.5rem | Icon-to-label gaps (`gap-2`), badge/chip internal padding |
| `4` | 1rem | Button padding (`p-4`), sidebar padding (`p-4`), list gaps |
| `8` | 2rem | Card internal padding (`p-8` on login card) |
| `16` | 4rem | Section vertical rhythm (`mb-10` login header) |
| `32` | 8rem | Hero sections, major page divisions |

**Permitted micro-exceptions used in this app:**
- `1` — badge/chip padding, avatar ring
- `1.5` — compact padding (`w-1.5 h-1.5` status dot)
- `2` — tight gaps throughout (`gap-2`, `gap-3`)
- `3` — sidebar list item padding (`p-2`, `px-2 py-2`)
- `5` — login button tall padding (`py-5`) — Figma spec for large CTA
- `6` — spacing in footer sections (`pt-6`, `mt-6`) — Figma spec

---

## Border Radius
Adjusted to reflect actual values used in App.tsx:

| Token | rem | Tailwind | Usage in App |
|---|---|---|---|
| radius-sm | 0.25rem | `rounded` | Badges, chips, status indicators |
| radius-md | 0.375rem | `rounded-md` | Buttons, inputs, sidebar items |
| radius-lg | 0.5rem | `rounded-lg` | Login card, panel containers |
| radius-xl | 0.75rem | `rounded-xl` | Modals, large floating panels |
| radius-2xl | 1rem | `rounded-2xl` | Not used — reserved |
| radius-full | 9999px | `rounded-full` | Avatar circles, theme toggle button, pills |

---

## Shadows

| Token | Value | Usage in App |
|---|---|---|
| shadow-card | `0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)` | Default card shadow |
| shadow-card-hover | `0 4px 6px rgba(0,0,0,0.1), 0 2px 4px rgba(0,0,0,0.06)` | Card on hover |
| shadow-modal | `0 20px 25px rgba(0,0,0,0.15), 0 10px 10px rgba(0,0,0,0.04)` | Modals, login card (`shadow-xl` equivalent) |
| shadow-dropdown | `0 4px 6px rgba(0,0,0,0.07), 0 2px 4px rgba(0,0,0,0.06)` | Dropdowns, tooltips |
| shadow-button | `0 1px 2px rgba(0,0,0,0.05)` | Subtle button depth |
| shadow-inner | `inset 0 2px 4px rgba(0,0,0,0.06)` | Pressed states, sunken inputs |
| shadow-glow-green | `0 0 50px rgba(34,197,94,0.1)` | **Dark mode only** — login card glow |

---

## Hover Shade Map

| Base | Hover | Element type |
|---|---|---|
| `slate-900` (#0f172a) | `slate-800` (#1e293b) | Primary button bg (light mode) |
| `green-500` (#22c55e) | `green-400` (#4ade80) | Primary button bg (dark mode) |
| `neutral-50` | `neutral-100` | Card hover bg, sidebar item hover |
| `white` | `neutral-50` | Subtle card / user profile row hover |
| `shadow-card` | `shadow-card-hover` | Card shadow elevation |
| `border-default` | `border-strong` | Input/field focus |
| transparent | `green-500/5` | Ghost sidebar button hover (dark mode) |
| transparent | `slate-100` | Ghost sidebar button hover (light mode) |
| transparent | `red-500/5` | Destructive action hover (Terminate Session) |

---

## Tailwind Config Reference

```ts
import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#f8fafc',  // slate-50
          100: '#f1f5f9',  // slate-100
          200: '#e2e8f0',  // slate-200
          300: '#cbd5e1',  // slate-300
          400: '#94a3b8',  // slate-400
          500: '#64748b',  // slate-500
          600: '#475569',  // slate-600
          700: '#334155',  // slate-700
          800: '#1e293b',  // slate-800
          900: '#0f172a',  // slate-900 — primary button, headings (light default)
        },
        // Dark mode accent (green) — apply via .dark class or next-themes
        accent: {
          400: '#4ade80',  // green-400 — dark mode button hover
          500: '#22c55e',  // green-500 — dark mode primary brand
        },
        surface: {
          default: '#f8fafc',  // slate-50 — page background
          raised:  '#ffffff',  // cards, sidebar, dropdowns
          overlay: '#ffffff',  // login card (use bg-white/80 for blur)
          sunken:  '#f1f5f9',  // slate-100 — inputs, code blocks
        },
        border: {
          default: '#e2e8f0',  // slate-200 — card/sidebar borders
          strong:  '#f1f5f9',  // slate-100 — internal section dividers
        },
        success: {
          50:  '#f0fdf4',  // green-50
          500: '#22c55e',  // green-500
        },
        error: {
          50:  '#fef2f2',  // red-50
          500: '#ef4444',  // red-500
        },
        warning: {
          50:  '#fffbeb',  // amber-50
          500: '#f59e0b',  // amber-500
        },
      },
      fontFamily: {
        // Single mono font used across all roles
        display: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        body:    ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        mono:    ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        'card':         '0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)',
        'card-hover':   '0 4px 6px rgba(0,0,0,0.1), 0 2px 4px rgba(0,0,0,0.06)',
        'modal':        '0 20px 25px rgba(0,0,0,0.15), 0 10px 10px rgba(0,0,0,0.04)',
        'dropdown':     '0 4px 6px rgba(0,0,0,0.07), 0 2px 4px rgba(0,0,0,0.06)',
        'button':       '0 1px 2px rgba(0,0,0,0.05)',
        'inner':        'inset 0 2px 4px rgba(0,0,0,0.06)',
        'glow-green':   '0 0 50px rgba(34,197,94,0.1)', // dark mode login card
      },
    },
  },
  plugins: [],
}

export default config
```

### next/font Setup (app/layout.tsx)

```tsx
import { JetBrains_Mono } from 'next/font/google'

const monoFont = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400', '500', '700'],
})

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Default: light class. Toggle to 'dark' via state/next-themes
    <html lang="en" className={`${monoFont.variable} light`}>
      <body className="font-mono bg-slate-50 text-slate-900 transition-colors duration-300">
        {children}
      </body>
    </html>
  )
}
```

### CSS Variable Registration (index.css)

```css
@import "tailwindcss";

@theme {
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
}

@layer base {
  body {
    @apply font-mono overflow-hidden transition-colors duration-300;
  }

  /* Light mode — DEFAULT */
  body,
  body.light {
    @apply bg-slate-50 text-slate-900;
  }

  /* Dark mode */
  body.dark {
    background-color: #1a1a1a;
    @apply text-green-500;
  }
}
```
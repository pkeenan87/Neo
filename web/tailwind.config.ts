import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './context/**/*.{ts,tsx}',
  ],
  // Enables .dark class-based dark mode (toggled manually via ThemeContext)
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Brand = Slate scale (light-mode default)
        brand: {
          50:  '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a', // primary button, headings (light default)
        },
        // Dark mode accent — Discord-inspired muted green, not neon
        accent: {
          400: '#4cba6e', // hover state
          500: '#3ba55d', // primary interactive color in dark mode
          600: '#15693a', // darker shade — used for icon/text over light success tints to clear WCAG AA 4.5:1
        },
        surface: {
          default: '#f8fafc', // page background
          raised:  '#ffffff', // cards, sidebar, dropdowns
          overlay: '#ffffff', // login card (use bg-white/80 + backdrop-blur)
          sunken:  '#f1f5f9', // inputs, code blocks
        },
        border: {
          default: '#e2e8f0', // card/sidebar borders
          strong:  '#f1f5f9', // internal section dividers
        },
        // Dark mode surfaces — Discord-inspired charcoal palette
        'dark-surface': {
          default: '#313338', // Discord bg-primary — main app background
          raised:  '#2b2d31', // Discord bg-secondary — sidebar, cards
          overlay: '#383a40', // Discord bg-floating — modal/login card
          sunken:  '#1e1f22', // Discord bg-tertiary — inputs, code blocks
        },
        success: {
          50:  '#f0fdf4',
          500: '#22c55e',
        },
        error: {
          50:  '#fef2f2',
          500: '#ef4444',
        },
        warning: {
          50:  '#fffbeb',
          500: '#f59e0b',
        },
      },
      fontFamily: {
        // Single mono font across all roles per design-tokens.md
        display: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        body:    ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        mono:    ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        'card':        '0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)',
        'card-hover':  '0 4px 6px rgba(0,0,0,0.1), 0 2px 4px rgba(0,0,0,0.06)',
        'modal':       '0 20px 25px rgba(0,0,0,0.15), 0 10px 10px rgba(0,0,0,0.04)',
        'dropdown':    '0 4px 6px rgba(0,0,0,0.07), 0 2px 4px rgba(0,0,0,0.06)',
        'button':      '0 1px 2px rgba(0,0,0,0.05)',
        'inner':       'inset 0 2px 4px rgba(0,0,0,0.06)',
        'glow-green':  '0 0 30px rgba(59,165,93,0.07)', // dark mode login card — subtle, Discord-toned
      },
    },
  },
  plugins: [],
}

export default config

# Component Patterns

Canonical structures for recurring component types. Use these as the baseline when building
from a Figma spec — they enforce the 3-class rule, correct hover patterns, and proper TypeScript
shapes. Adapt the visual details (colors, sizes) to match the specific design, but keep the
structural skeleton intact.

---

## Button

```
Button/
  Button.tsx
  Button.module.css
  index.ts
```

**Button.tsx**
```tsx
import styles from './Button.module.css'

interface ButtonProps {
  children: React.ReactNode
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive'
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  type?: 'button' | 'submit' | 'reset'
  className?: string
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  disabled = false,
  onClick,
  type = 'button',
  className,
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`${styles.base} ${styles[variant]} ${styles[size]} ${className ?? ''}`}
    >
      {children}
    </button>
  )
}
```

**Button.module.css**
```css
.base {
  @apply inline-flex items-center justify-center font-body font-semibold
         rounded-lg transition-colors duration-150 cursor-pointer
         disabled:opacity-50 disabled:cursor-not-allowed;
}

/* Sizes — padding on 8pt grid, gap micro-exception allowed */
.sm  { @apply text-sm px-4 py-2 gap-2; }
.md  { @apply text-base px-4 py-2 gap-2; }
.lg  { @apply text-lg px-8 py-4 gap-2; }

/* Variants */
.primary {
  @apply bg-brand-600 text-white shadow-button;
}
.primary:hover:not(:disabled) {
  @apply bg-brand-700;
}
.primary:active:not(:disabled) {
  @apply bg-brand-800;
}

.secondary {
  @apply bg-white text-brand-600 border border-border-default shadow-button;
}
.secondary:hover:not(:disabled) {
  @apply bg-neutral-50 border-border-strong;
}

.ghost {
  @apply bg-transparent text-brand-600;
}
.ghost:hover:not(:disabled) {
  @apply bg-brand-50;
}

.destructive {
  @apply bg-error-500 text-white;
}
.destructive:hover:not(:disabled) {
  @apply bg-red-700;
}
```

---

## Card

```
Card/
  Card.tsx
  Card.module.css
  index.ts
```

**Card.tsx**
```tsx
import styles from './Card.module.css'

interface CardProps {
  children: React.ReactNode
  interactive?: boolean  // adds hover elevation
  padding?: 'sm' | 'md' | 'lg'
  className?: string
}

export function Card({
  children,
  interactive = false,
  padding = 'md',
  className,
}: CardProps) {
  return (
    <div
      className={`
        ${styles.card}
        ${styles[`padding-${padding}`]}
        ${interactive ? styles.interactive : ''}
        ${className ?? ''}
      `}
    >
      {children}
    </div>
  )
}
```

**Card.module.css**
```css
.card {
  @apply bg-surface-raised rounded-xl shadow-card flex flex-col;
}

.padding-sm { @apply p-4; }
.padding-md { @apply p-8; }  /* 2rem — 8pt grid primary step */
.padding-lg { @apply p-16; } /* 4rem — 8pt grid primary step */

.interactive {
  @apply transition-shadow duration-200 cursor-pointer;
}
.interactive:hover {
  @apply shadow-card-hover;
}
```

---

## Input

```
Input/
  Input.tsx
  Input.module.css
  index.ts
```

**Input.tsx**
```tsx
import styles from './Input.module.css'

interface InputProps {
  label?: string
  placeholder?: string
  value?: string
  onChange?: React.ChangeEventHandler<HTMLInputElement>
  error?: string
  disabled?: boolean
  type?: React.HTMLInputTypeAttribute
  id?: string
  className?: string
}

export function Input({
  label,
  placeholder,
  value,
  onChange,
  error,
  disabled = false,
  type = 'text',
  id,
  className,
}: InputProps) {
  return (
    <div className={`${styles.fieldWrapper} ${className ?? ''}`}>
      {label && (
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
      )}
      <input
        id={id}
        type={type}
        value={value}
        onChange={onChange}
        disabled={disabled}
        placeholder={placeholder}
        className={`${styles.input} ${error ? styles.inputError : ''}`}
      />
      {error && <p className={styles.errorMessage}>{error}</p>}
    </div>
  )
}
```

**Input.module.css**
```css
.fieldWrapper {
  @apply flex flex-col gap-1.5 w-full;
}

.label {
  @apply text-sm font-medium text-neutral-700;
}

.input {
  @apply w-full px-4 py-2 rounded-lg text-base font-body text-neutral-900
         bg-surface-sunken border border-border-default
         placeholder:text-neutral-400
         focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20
         disabled:opacity-50 disabled:cursor-not-allowed
         transition-colors duration-150;
         /* py-2 = 0.5rem micro-exception — input needs tighter vertical than 1rem */
}

.inputError {
  @apply border-error-500 focus:border-error-500 focus:ring-error-500/20;
}

.errorMessage {
  @apply text-sm text-error-500;
}
```

---

## NavBar

```
NavBar/
  NavBar.tsx
  NavBar.module.css
  index.ts
```

**NavBar.tsx**
```tsx
import Link from 'next/link'
import styles from './NavBar.module.css'

interface NavItem {
  label: string
  href: string
}

interface NavBarProps {
  items: NavItem[]
  logo?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}

export function NavBar({ items, logo, actions, className }: NavBarProps) {
  return (
    <nav className={`${styles.nav} ${className ?? ''}`}>
      <div className={styles.inner}>
        {logo && <div className={styles.logoArea}>{logo}</div>}
        <ul className={styles.navList}>
          {items.map((item) => (
            <li key={item.href}>
              <Link href={item.href} className={styles.navLink}>
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
        {actions && <div className={styles.actionsArea}>{actions}</div>}
      </div>
    </nav>
  )
}
```

**NavBar.module.css**
```css
.nav {
  @apply w-full border-b border-border-default bg-surface-raised;
}

.inner {
  /* 8pt grid: px-8=32px, h-16=64px, gap-8=32px */
  @apply max-w-7xl mx-auto px-8 h-16 flex items-center justify-between gap-8;
}

.logoArea {
  @apply flex-shrink-0;
}

.navList {
  @apply flex items-center gap-2 list-none m-0 p-0;
}

.navLink {
  @apply px-4 py-2 rounded-lg text-sm font-medium text-neutral-600
         transition-colors duration-150;
}
.navLink:hover {
  @apply text-neutral-900 bg-neutral-50;
}

.actionsArea {
  @apply flex items-center gap-4 flex-shrink-0;
}
```

---

## Modal

```
Modal/
  Modal.tsx
  Modal.module.css
  index.ts
```

**Modal.tsx**
```tsx
import { useEffect } from 'react'
import styles from './Modal.module.css'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = 'md',
  className,
}: ModalProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (isOpen) document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={`${styles.panel} ${styles[size]} ${className ?? ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {title && (
          <div className={styles.header}>
            <h2 className={styles.title}>{title}</h2>
            <button onClick={onClose} className={styles.closeBtn} aria-label="Close">
              ✕
            </button>
          </div>
        )}
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  )
}
```

**Modal.module.css**
```css
.backdrop {
  @apply fixed inset-0 z-50 flex items-center justify-center p-4
         bg-black/50 backdrop-blur-sm;
}

.panel {
  @apply bg-surface-overlay rounded-2xl shadow-modal
         flex flex-col w-full max-h-[90vh] overflow-y-auto;
}

.sm  { @apply max-w-sm; }
.md  { @apply max-w-lg; }
.lg  { @apply max-w-2xl; }

.header {
  @apply flex items-center justify-between px-6 pt-5 pb-4
         border-b border-border-default;
}

.title {
  @apply text-xl font-semibold text-neutral-900 font-display leading-snug;
}

.closeBtn {
  @apply p-1.5 rounded-lg text-neutral-400 transition-colors duration-150;
}
.closeBtn:hover {
  @apply text-neutral-600 bg-neutral-100;
}

.body {
  @apply px-6 py-5;
}
```

---

## Badge / Chip

```
Badge/
  Badge.tsx
  Badge.module.css
  index.ts
```

**Badge.tsx**
```tsx
import styles from './Badge.module.css'

interface BadgeProps {
  children: React.ReactNode
  variant?: 'default' | 'success' | 'error' | 'warning' | 'brand'
  size?: 'sm' | 'md'
  className?: string
}

export function Badge({
  children,
  variant = 'default',
  size = 'md',
  className,
}: BadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[variant]} ${styles[size]} ${className ?? ''}`}>
      {children}
    </span>
  )
}
```

**Badge.module.css**
```css
.badge {
  @apply inline-flex items-center font-medium rounded font-body;
}

.sm { @apply text-xs px-2 py-0.5; }
.md { @apply text-sm px-2.5 py-1; }

.default { @apply bg-neutral-100 text-neutral-700; }
.success  { @apply bg-success-50 text-green-700; }
.error    { @apply bg-error-50 text-red-700; }
.warning  { @apply bg-warning-50 text-amber-700; }
.brand    { @apply bg-brand-50 text-brand-700; }
```

---

## Component Barrel Export (components/index.ts)

```ts
export * from './Badge'
export * from './Button'
export * from './Card'
export * from './Input'
export * from './Modal'
export * from './NavBar'
```

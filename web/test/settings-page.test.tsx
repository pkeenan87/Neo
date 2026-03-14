import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

// Mock ThemeContext
const mockSetTheme = vi.fn()
const mockToggleTheme = vi.fn()
let mockTheme = 'auto' as 'light' | 'dark' | 'auto'

vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({
    theme: mockTheme,
    setTheme: mockSetTheme,
    toggleTheme: mockToggleTheme,
  }),
}))

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  ArrowLeft: () => <span data-testid="arrow-left-icon" />,
  RefreshCw: ({ className }: { className?: string }) => <span data-testid="refresh-icon" className={className} />,
}))

// Mock only UserAvatar from the barrel
vi.mock('@/components', () => ({
  UserAvatar: ({ userName }: { userName?: string }) => <div data-testid="user-avatar">{userName}</div>,
}))

import { ProgressBar } from '../components/SettingsPage/ProgressBar'
import { SettingsPage } from '../components/SettingsPage/SettingsPage'

// ── ProgressBar ─────────────────────────────────────────────

describe('ProgressBar', () => {
  afterEach(() => cleanup())

  it('calculates 0% for zero usage', () => {
    render(<ProgressBar label="Test" subtitle="sub" value={0} max={55000} />)
    expect(screen.getByText('0% used')).toBeTruthy()
  })

  it('calculates 50% correctly', () => {
    render(<ProgressBar label="Test" subtitle="sub" value={27500} max={55000} />)
    expect(screen.getByText('50% used')).toBeTruthy()
  })

  it('calculates 100% at limit', () => {
    render(<ProgressBar label="Test" subtitle="sub" value={55000} max={55000} />)
    expect(screen.getByText('100% used')).toBeTruthy()
  })

  it('caps at 100% when over limit', () => {
    render(<ProgressBar label="Test" subtitle="sub" value={60000} max={55000} />)
    expect(screen.getByText('100% used')).toBeTruthy()
  })

  it('handles max=0 gracefully', () => {
    render(<ProgressBar label="Test" subtitle="sub" value={0} max={0} />)
    expect(screen.getByText('0% used')).toBeTruthy()
  })

  it('renders label and subtitle', () => {
    render(<ProgressBar label="Current session" subtitle="Resets in ~2 hr" value={10000} max={55000} />)
    expect(screen.getByText('Current session')).toBeTruthy()
    expect(screen.getByText('Resets in ~2 hr')).toBeTruthy()
  })

  it('has accessible role and aria attributes on the track', () => {
    const { container } = render(<ProgressBar label="Session" subtitle="sub" value={27500} max={55000} />)
    const bar = container.querySelector('[role="progressbar"]')!
    expect(bar.getAttribute('aria-valuenow')).toBe('50')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
    expect(bar.getAttribute('aria-valuetext')).toBe('Session: 50% used')
  })
})

// ── SettingsPage ─────────────────────────────────────────────

describe('SettingsPage', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    mockTheme = 'auto'
    mockSetTheme.mockClear()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
    })
  })

  it('renders General tab by default with Profile and Appearance', () => {
    render(<SettingsPage userName="Test User" />)
    expect(screen.getByText('Profile')).toBeTruthy()
    expect(screen.getByText('Appearance')).toBeTruthy()
  })

  it('shows back link to chat', () => {
    render(<SettingsPage userName="Test User" />)
    const backLink = screen.getByText('Back to chat')
    expect(backLink.closest('a')?.getAttribute('href')).toBe('/chat')
  })

  it('uses tablist ARIA pattern', () => {
    render(<SettingsPage userName="Test User" />)
    const tablist = screen.getByRole('tablist')
    expect(tablist).toBeTruthy()
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(tabs[1].getAttribute('aria-selected')).toBe('false')
  })

  it('switches to Usage tab when clicked', () => {
    render(<SettingsPage userName="Test User" />)
    fireEvent.click(screen.getByText('Usage'))
    expect(screen.getByText('Plan usage limits')).toBeTruthy()
    expect(screen.queryByText('Profile')).toBeNull()
  })

  it('switches back to General tab', () => {
    render(<SettingsPage userName="Test User" />)
    fireEvent.click(screen.getByText('Usage'))
    fireEvent.click(screen.getByText('General'))
    expect(screen.getByText('Profile')).toBeTruthy()
  })

  it('calls setTheme when a color mode card is clicked', () => {
    render(<SettingsPage userName="Test User" />)
    fireEvent.click(screen.getByText('Dark'))
    expect(mockSetTheme).toHaveBeenCalledWith('dark')
  })

  it('calls setTheme with light when Light card clicked', () => {
    mockTheme = 'dark'
    render(<SettingsPage userName="Test User" />)
    fireEvent.click(screen.getByText('Light'))
    expect(mockSetTheme).toHaveBeenCalledWith('light')
  })

  it('displays user name in profile section', () => {
    render(<SettingsPage userName="Patrick Keenan" />)
    const input = screen.getByDisplayValue('Patrick Keenan')
    expect(input).toBeTruthy()
    expect((input as HTMLInputElement).readOnly).toBe(true)
  })

  it('has tabpanel linked to active tab', () => {
    render(<SettingsPage userName="Test User" />)
    const panel = screen.getByRole('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe('tab-general')
  })
})

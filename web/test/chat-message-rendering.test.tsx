import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MarkdownRenderer } from '../components/MarkdownRenderer/MarkdownRenderer'

describe('MarkdownRenderer — heading scale', () => {
  afterEach(() => cleanup())

  it('renders H1 with the heading1 token class', () => {
    render(<MarkdownRenderer content="# Hello" />)
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1.className).toMatch(/heading1/)
  })

  it('renders H2 with the heading2 token class', () => {
    render(<MarkdownRenderer content="## Section" />)
    const h2 = screen.getByRole('heading', { level: 2 })
    expect(h2.className).toMatch(/heading2/)
  })

  it('renders H3 with the heading3 token class', () => {
    render(<MarkdownRenderer content="### Subsection" />)
    const h3 = screen.getByRole('heading', { level: 3 })
    expect(h3.className).toMatch(/heading3/)
  })
})

describe('MarkdownRenderer — table scroll wrapper', () => {
  afterEach(() => cleanup())

  it('wraps a markdown table in a tabIndex-0 element with an accessible name', () => {
    const tableMd = '| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |'
    const { container } = render(<MarkdownRenderer content={tableMd} />)
    const wrapper = container.querySelector('[aria-label="Scrollable table"]')
    expect(wrapper).toBeTruthy()
    expect(wrapper!.getAttribute('tabIndex')).toBe('0')
    // The table should sit inside the wrapper.
    expect(wrapper!.querySelector('table')).toBeTruthy()
  })

  it('does NOT use role="region" on the table wrapper (avoids landmark pollution)', () => {
    const tableMd = '| a | b |\n|---|---|\n| 1 | 2 |'
    const { container } = render(<MarkdownRenderer content={tableMd} />)
    const wrapper = container.querySelector('[aria-label="Scrollable table"]')
    expect(wrapper).toBeTruthy()
    expect(wrapper!.getAttribute('role')).toBeNull()
  })
})

describe('MarkdownRenderer — code block scroll wrapper', () => {
  afterEach(() => cleanup())

  it('marks fenced code block pre with tabIndex and an accessible name', () => {
    const codeMd = '```\nlong long long long line of code\n```'
    const { container } = render(<MarkdownRenderer content={codeMd} />)
    const pre = container.querySelector('pre')
    expect(pre).toBeTruthy()
    expect(pre!.getAttribute('tabIndex')).toBe('0')
    expect(pre!.getAttribute('aria-label')).toMatch(/scrollable code block/i)
  })

  it('does NOT use role="region" on the pre (ARIA-in-HTML disallows it)', () => {
    const codeMd = '```\nx\n```'
    const { container } = render(<MarkdownRenderer content={codeMd} />)
    const pre = container.querySelector('pre')
    expect(pre).toBeTruthy()
    expect(pre!.getAttribute('role')).toBeNull()
  })
})

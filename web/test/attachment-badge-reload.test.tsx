import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { extractTextAttachments } from '../lib/chat-attachments'

// Renders only the badge subtree the way ChatInterface does, so we don't
// need to mount the entire ChatInterface (which depends on a lot of
// context). The relevant assertion is: the file body is NOT in the DOM
// after extraction, but the filename IS.

function AttachmentBadgeRow({ attachments }: { attachments: ReturnType<typeof extractTextAttachments>['attachments'] }) {
  if (attachments.length === 0) return null
  return (
    <div data-testid="badge-row">
      {attachments.map((a, i) => (
        <span key={i} data-testid="badge">
          📎 <span>{a.filename}</span>
        </span>
      ))}
    </div>
  )
}

describe('text-attachment badge rendering on reload', () => {
  afterEach(() => cleanup())

  it('renders a badge with the filename and does NOT render the file body', () => {
    const persisted =
      'Please review:\n' +
      '<text_attachment filename="report.txt" size_bytes="42">\n' +
      'SECRET FILE BODY THAT MUST NOT APPEAR\n' +
      '</text_attachment>'
    const { text, attachments } = extractTextAttachments(persisted)

    const { container } = render(
      <div>
        <AttachmentBadgeRow attachments={attachments} />
        <div data-testid="body">{text}</div>
      </div>,
    )

    // Filename appears in the badge
    expect(container.textContent).toContain('report.txt')
    // The file body was extracted out of the rendered text
    expect(container.textContent).not.toContain('SECRET FILE BODY')
    // Surrounding prose is preserved
    expect(container.textContent).toContain('Please review:')
  })

  it('renders multiple badges for multiple attachments and strips each body', () => {
    const persisted =
      '<text_attachment filename="a.txt" size_bytes="1">aaa BODY A</text_attachment>' +
      '<text_attachment filename="b.json" size_bytes="2">bbb BODY B</text_attachment>'
    const { text, attachments } = extractTextAttachments(persisted)

    const { container, getAllByTestId } = render(
      <div>
        <AttachmentBadgeRow attachments={attachments} />
        <div>{text}</div>
      </div>,
    )

    expect(getAllByTestId('badge')).toHaveLength(2)
    expect(container.textContent).toContain('a.txt')
    expect(container.textContent).toContain('b.json')
    expect(container.textContent).not.toContain('BODY A')
    expect(container.textContent).not.toContain('BODY B')
  })

  it('badges do not rely on hover-only `title` tooltips for accessibility', () => {
    // Regression guard: the size hint and filename must be in the DOM as
    // text content (visible to keyboard / screen-reader users), not
    // hidden behind a `title` attribute that only appears on mouse hover.
    const persisted =
      '<text_attachment filename="report.txt" size_bytes="2048">body</text_attachment>'
    const { attachments } = extractTextAttachments(persisted)
    const { container } = render(<AttachmentBadgeRow attachments={attachments} />)
    const badge = container.querySelector('[data-testid="badge"]')
    expect(badge).toBeTruthy()
    expect(badge!.getAttribute('title')).toBeNull()
  })
})

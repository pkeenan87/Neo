import { describe, it, expect } from 'vitest'
import { extractTextAttachments, formatAttachmentSize } from '../lib/chat-attachments'

describe('extractTextAttachments', () => {
  it('returns content unchanged when there are no text_attachment blocks', () => {
    const input = 'Hello world\n\nNo attachments here.'
    const result = extractTextAttachments(input)
    expect(result.text).toBe(input)
    expect(result.attachments).toEqual([])
  })

  it('extracts a single text_attachment block and removes it from the content', () => {
    const input = 'Look at this:\n<text_attachment filename="notes.txt" size_bytes="1234">\nfile body here\n</text_attachment>'
    const result = extractTextAttachments(input)
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]).toEqual({
      filename: 'notes.txt',
      sizeBytes: 1234,
      kind: 'text',
    })
    expect(result.text).toBe('Look at this:')
    expect(result.text).not.toContain('file body here')
  })

  it('extracts multiple blocks in document order', () => {
    const input =
      '<text_attachment filename="a.txt" size_bytes="10">A</text_attachment>\n' +
      '<text_attachment filename="b.json" size_bytes="20">B</text_attachment>'
    const result = extractTextAttachments(input)
    expect(result.attachments.map((a) => a.filename)).toEqual(['a.txt', 'b.json'])
    expect(result.attachments.map((a) => a.sizeBytes)).toEqual([10, 20])
  })

  it('decodes HTML-encoded attribute values written by escapeAttr', () => {
    const input = '<text_attachment filename="weird&quot;name&amp;1.txt" size_bytes="5">x</text_attachment>'
    const result = extractTextAttachments(input)
    expect(result.attachments[0].filename).toBe('weird"name&1.txt')
  })

  it('handles malformed (no closing tag) input by leaving content intact', () => {
    const input = '<text_attachment filename="oops.txt" size_bytes="5">no closing tag here'
    const result = extractTextAttachments(input)
    expect(result.attachments).toEqual([])
    expect(result.text).toBe(input)
  })

  it('defaults sizeBytes to 0 when the attribute is missing or non-numeric', () => {
    const input = '<text_attachment filename="x.txt" size_bytes="not-a-number">body</text_attachment>'
    const result = extractTextAttachments(input)
    expect(result.attachments[0].sizeBytes).toBe(0)
  })
})

describe('formatAttachmentSize', () => {
  it('returns "" for zero or negative byte counts', () => {
    expect(formatAttachmentSize(0)).toBe('')
    expect(formatAttachmentSize(-1)).toBe('')
  })

  it('formats bytes < 1024 as B', () => {
    expect(formatAttachmentSize(512)).toBe('512 B')
  })

  it('formats KB with one decimal under 10 KB and integer above', () => {
    expect(formatAttachmentSize(1024)).toBe('1.0 KB')
    expect(formatAttachmentSize(50_000)).toBe('49 KB')
  })

  it('formats MB with one decimal under 10 MB', () => {
    expect(formatAttachmentSize(1_500_000)).toBe('1.4 MB')
  })
})

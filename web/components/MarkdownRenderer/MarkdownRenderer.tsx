'use client'

import { useState, useCallback, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import type { Components } from 'react-markdown'
import styles from './MarkdownRenderer.module.css'

export interface MarkdownRendererProps {
  content: string
  className?: string
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for environments without clipboard API
    }
  }, [text])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={styles.copyButton}
      aria-label="Copy code to clipboard"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

const components: Components = {
  h1: ({ children }) => <h1 className={styles.heading1}>{children}</h1>,
  h2: ({ children }) => <h2 className={styles.heading2}>{children}</h2>,
  h3: ({ children }) => <h3 className={styles.heading3}>{children}</h3>,
  h4: ({ children }) => <h4 className={styles.heading4}>{children}</h4>,
  p: ({ children }) => <p className={styles.paragraph}>{children}</p>,
  ul: ({ children }) => <ul className={styles.unorderedList}>{children}</ul>,
  ol: ({ children }) => <ol className={styles.orderedList}>{children}</ol>,
  li: ({ children }) => <li className={styles.listItem}>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className={styles.blockquote}>{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className={styles.tableRow}>{children}</tr>,
  th: ({ children }) => <th className={styles.tableHeader}>{children}</th>,
  td: ({ children }) => <td className={styles.tableCell}>{children}</td>,
  a: ({ href, children }) => (
    <a href={href} className={styles.link} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className={styles.bold}>{children}</strong>,
  em: ({ children }) => <em className={styles.italic}>{children}</em>,
  hr: () => <hr className={styles.divider} />,
  pre: ({ children }) => {
    // Extract text content from the code child for the copy button
    const codeText = extractTextFromChildren(children)
    return (
      <div className={styles.codeBlockWrapper}>
        <div className={styles.codeBlockHeader}>
          <CopyButton text={codeText} />
        </div>
        <pre className={styles.codeBlock}>{children}</pre>
      </div>
    )
  },
  code: ({ className, children, ...rest }) => {
    // Fenced code blocks have a className like "language-kql"
    const isInline = !className
    if (isInline) {
      return <code className={styles.inlineCode} {...rest}>{children}</code>
    }
    return <code className={`${styles.codeContent} ${className ?? ''}`} {...rest}>{children}</code>
  },
}

function extractTextFromChildren(children: ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(extractTextFromChildren).join('')
  if (children && typeof children === 'object' && 'props' in children) {
    const props = children.props as Record<string, unknown>
    return extractTextFromChildren(props.children as ReactNode)
  }
  return ''
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const normalized = normalizeText(content)

  return (
    <div className={`${styles.wrapper} ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={components}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  )
}

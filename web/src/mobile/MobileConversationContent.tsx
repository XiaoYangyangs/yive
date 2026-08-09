import DOMPurify from 'isomorphic-dompurify'
import { marked } from 'marked'
import { useId, useMemo, useState } from 'react'

import { normalizeVerifiedConversationText } from '../../../src/shared/conversation-content.js'
import './MobileConversationContent.css'

const escapeHtml = (value: string) =>
  value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')

const languageLabel = (language: string | undefined) => {
  const normalized = language?.trim().toLowerCase() ?? ''
  const labels: Record<string, string> = {
    bash: 'Shell',
    css: 'CSS',
    html: 'HTML',
    js: 'JavaScript',
    javascript: 'JavaScript',
    json: 'JSON',
    python: 'Python',
    sh: 'Shell',
    sql: 'SQL',
    ts: 'TypeScript',
    tsx: 'TSX',
    typescript: 'TypeScript',
  }
  return labels[normalized] ?? (normalized ? normalized.toUpperCase() : 'Code')
}

const renderer = new marked.Renderer()
renderer.html = ({ text }) => escapeHtml(text)
renderer.image = ({ text }) => escapeHtml(text)
renderer.link = ({ href, text, title }) => {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return escapeHtml(text)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return escapeHtml(text)
  return `<a href="${escapeHtml(url.href)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(text)}</a>`
}
renderer.code = ({ lang, text }) => {
  const encoded = encodeURIComponent(text)
  return `<div class="mobile-conversation-content__code"><div class="mobile-conversation-content__code-header"><span>${escapeHtml(languageLabel(lang))}</span><button type="button" data-copy-code="${encoded}">复制代码</button></div><pre><code>${escapeHtml(text)}</code></pre></div>`
}

const renderSafeMarkdown = (text: string) => {
  const raw = marked.parse(text, { async: false, breaks: true, gfm: true, renderer })
  if (typeof raw !== 'string') throw new Error('marked.parse returned a non-string value')
  return DOMPurify.sanitize(raw, {
    ALLOWED_ATTR: ['data-copy-code', 'href', 'title', 'type', 'class'],
    ALLOWED_TAGS: [
      'a',
      'blockquote',
      'br',
      'button',
      'code',
      'del',
      'div',
      'em',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'hr',
      'li',
      'ol',
      'p',
      'pre',
      'span',
      'strong',
      'table',
      'tbody',
      'td',
      'th',
      'thead',
      'tr',
      'ul',
    ],
  })
}

const SafeMarkdown = ({ text }: { text: string }) => {
  const html = useMemo(() => renderSafeMarkdown(text), [text])
  return (
    <div
      className="mobile-conversation-content__body"
      onClick={(event) => {
        const target = event.target as HTMLElement
        const copyButton = target.closest<HTMLButtonElement>('[data-copy-code]')
        if (copyButton) {
          const encoded = copyButton.dataset.copyCode
          if (encoded) void navigator.clipboard?.writeText(decodeURIComponent(encoded))
          return
        }
        const anchor = target.closest<HTMLAnchorElement>('a[href]')
        if (!anchor) return
        event.preventDefault()
        const destination = new URL(anchor.href)
        if (window.confirm(`即将打开外部网站 ${destination.hostname}，是否继续？`)) {
          window.open(destination.href, '_blank', 'noopener,noreferrer')
        }
      }}
      onKeyDown={() => undefined}
      role="document"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: marked output is sanitized with a strict passive-content allowlist above.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export const MobileConversationContent = ({ text }: { text: string }) => {
  const normalizedText = useMemo(() => normalizeVerifiedConversationText(text), [text])
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  if (normalizedText.length <= 1_600) return <SafeMarkdown text={normalizedText} />
  const preview = `${normalizedText.slice(0, 700).trimEnd()}...`
  return (
    <div className="mobile-conversation-content">
      <div id={contentId}>
        <SafeMarkdown text={expanded ? normalizedText : preview} />
      </div>
      <button
        aria-controls={contentId}
        aria-expanded={expanded}
        className="mobile-conversation-content__disclosure"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        {expanded ? '收起回复' : '展开完整回复'}
      </button>
    </div>
  )
}

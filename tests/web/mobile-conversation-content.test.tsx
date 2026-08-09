// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import { MobileConversationContent } from '../../web/src/mobile/MobileConversationContent.js'

describe('mobile conversation content', () => {
  test('renders passive Markdown with scroll-safe code and tables', () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(
      <MobileConversationContent
        text={
          '## 结果\n\n- 第一项\n- 第二项\n\n```ts\nconst answer = 42\n```\n\n| 列 | 值 |\n|---|---|\n| A | B |'
        }
      />
    )

    expect(screen.getByRole('heading', { name: '结果' })).toBeInTheDocument()
    expect(screen.getByText('第一项')).toBeInTheDocument()
    expect(screen.getByText('TypeScript')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    expect(writeText).toHaveBeenCalledWith('const answer = 42')
    const codeScroller = screen.getByText('const answer = 42').closest('pre')
    expect(codeScroller).not.toBeNull()
    if (!codeScroller) throw new Error('Expected the code block to have a scroll container')
    expect(getComputedStyle(codeScroller).overflowX).toBe('auto')
    expect(getComputedStyle(screen.getByRole('table')).overflowX).toBe('auto')
  })

  test('does not render active HTML, remote images, unsafe URLs, local paths, or credentials', () => {
    const { container } = render(
      <MobileConversationContent
        text={
          '<script>alert(1)</script><iframe src="https://evil.example"></iframe>\n![remote](https://evil.example/a.png)\n[x](javascript:alert(1))\n[<button data-copy-code="injected">copy</button>](https://safe.example)\nC:\\Users\\secret\\key.txt HIVE_AGENT_TOKEN=top-secret\n<hive-system-reminder>hidden provider instruction</hive-system-reminder>'
        }
      />
    )

    expect(container.querySelector('script, iframe, img, button')).toBeNull()
    expect(container.querySelectorAll('a')).toHaveLength(1)
    expect(container.textContent).not.toContain('C:\\Users\\secret')
    expect(container.textContent).not.toContain('top-secret')
    expect(container.textContent).not.toContain('hidden provider instruction')
    expect(container.textContent).toContain('[local path]')
    expect(container.textContent).toContain('HIVE_AGENT_TOKEN=[redacted]')
  })

  test('confirms the destination domain before external navigation', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<MobileConversationContent text={'[文档](https://docs.example.com/path)'} />)

    fireEvent.click(screen.getByRole('link', { name: '文档' }))

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('docs.example.com'))
    expect(open).not.toHaveBeenCalled()
  })

  test('collapses long replies behind an accessible disclosure', () => {
    const hiddenTail = '只在完整回复里出现'
    const { container } = render(
      <MobileConversationContent text={`摘要\n\n${'长内容'.repeat(700)}${hiddenTail}`} />
    )

    const disclosure = screen.getByRole('button', { name: '展开完整回复' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(container.textContent).not.toContain(hiddenTail)

    fireEvent.click(disclosure)

    expect(screen.getByRole('button', { name: '收起回复' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(container.textContent).toContain(hiddenTail)
    expect(container.querySelectorAll('p')[0]?.textContent).toBe('摘要')
  })

  test('redacts credentials and hidden provider blocks before creating a long preview', () => {
    const prefix = 'a'.repeat(690)
    render(
      <MobileConversationContent
        text={`${prefix} DB_PASSWORD=boundary-secret <system-reminder>hidden middle</system-reminder> ${'b'.repeat(1_000)}`}
      />
    )

    expect(document.body.textContent).not.toContain('boundary-secret')
    expect(document.body.textContent).not.toContain('hidden middle')
    expect(document.body.textContent).toContain('DB_PASSWORD=[redacted]')
  })

  test('wraps a long unbroken word within the mobile content width', () => {
    const longWord = '界'.repeat(200)
    const { container } = render(<MobileConversationContent text={longWord} />)

    const content = container.querySelector('.mobile-conversation-content__body')
    expect(content).toHaveTextContent(longWord)
    if (!content) throw new Error('Expected rendered conversation content')
    expect(getComputedStyle(content).overflowWrap).toBe('anywhere')
    expect(getComputedStyle(content).maxWidth).toBe('100%')
  })

  test('inherits light and dark theme tokens without changing its bounded layout', () => {
    const { container } = render(<MobileConversationContent text={'```ts\nconst x = 1\n```'} />)
    const code = container.querySelector('.mobile-conversation-content__code')
    expect(code).not.toBeNull()
    if (!code) throw new Error('Expected a themed code block')

    container.style.setProperty('--bg-1', '#ffffff')
    container.style.setProperty('--text-primary', '#111111')
    expect(container.style.getPropertyValue('--bg-1')).toBe('#ffffff')

    const codeRule = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .find(
        (rule): rule is CSSStyleRule =>
          'selectorText' in rule && rule.selectorText === '.mobile-conversation-content__code'
      )
    expect(codeRule?.style.background).toBe('var(--bg-1)')

    container.style.setProperty('--bg-1', '#171717')
    container.style.setProperty('--text-primary', '#ebebeb')
    expect(container.style.getPropertyValue('--bg-1')).toBe('#171717')
    expect(getComputedStyle(code).maxWidth).toBe('100%')
  })
})

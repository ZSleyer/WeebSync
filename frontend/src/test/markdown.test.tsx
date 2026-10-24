import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import Markdown, { parseMarkdown } from '../components/Markdown'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

describe('Markdown accessibility and title links', () => {
  it('makes a code block a focusable, named region so its long lines can be scrolled by keyboard', () => {
    render(<Markdown text={'```\nsome very long shell line\n```'} />)
    const region = screen.getByRole('region', { name: 'assistant.codeBlock' })
    expect(region.tagName).toBe('PRE')
    expect(region).toHaveAttribute('tabindex', '0')
  })

  it('links a short title only as a whole word', () => {
    render(
      <Markdown
        text={'a fair price, elaborate, Gate keeper, but Air is fine, and (Air).'}
        titles={[
          { title: 'Air', onClick: () => {} },
          { title: 'Gate', onClick: () => {} },
        ]}
      />,
    )
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Gate', 'Air', 'Air'])
    expect(screen.getByText(/a fair price, elaborate/)).toBeTruthy()
  })

  it('links a Korean title that carries a particle', () => {
    render(<Markdown text={'나 혼자만 레벨업은 재밌다'} titles={[{ title: '레벨업', onClick: () => {} }]} />)
    expect(screen.getByRole('button').textContent).toBe('레벨업')
  })

  it('links a Latin title next to Japanese text, but not inside a Latin word', () => {
    render(
      <Markdown
        text={'Frierenの旅 と 葬送のFrieren and Frierens'}
        titles={[{ title: 'Frieren', onClick: () => {} }]}
      />,
    )
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Frieren', 'Frieren'])
  })

  it('still links Japanese titles inside running text', () => {
    render(<Markdown text={'今日はナルトの冒険'} titles={[{ title: 'ナルト', onClick: () => {} }]} />)
    expect(screen.getByRole('button').textContent).toBe('ナルト')
  })
})

describe('parseMarkdown', () => {
  it('splits headings, lists, code and paragraphs', () => {
    const blocks = parseMarkdown(
      '# Picks\n\nTwo for you:\n- Frieren\n- Dan Da Dan\n\n1. first\n2) second\n```\nx = 1\n```\ntail',
    )
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'para', 'list', 'list', 'code', 'para'])
    expect(blocks[2]).toEqual({ kind: 'list', ordered: false, items: ['Frieren', 'Dan Da Dan'] })
    expect(blocks[3]).toEqual({ kind: 'list', ordered: true, items: ['first', 'second'] })
    expect(blocks[4]).toEqual({ kind: 'code', text: 'x = 1' })
  })
})

describe('Markdown', () => {
  it('renders inline marks and never html', () => {
    render(<Markdown text={'**bold** and *soft* with `code` and [a link](https://example.com) <b>raw</b>'} />)
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getByText('soft').tagName).toBe('EM')
    expect(screen.getByText('code').tagName).toBe('CODE')
    expect(screen.getByRole('link', { name: 'a link' })).toHaveAttribute('href', 'https://example.com')
    expect(screen.getByText(/<b>raw<\/b>/)).toBeTruthy()
  })
  it('turns named titles into buttons, longest title first', () => {
    const open = vi.fn()
    render(
      <Markdown
        text={'- Grand Blue Dreaming Season 3\n- Grand Blue Dreaming'}
        titles={[
          { title: 'Grand Blue Dreaming', onClick: () => open('s1') },
          { title: 'Grand Blue Dreaming Season 3', onClick: () => open('s3') },
        ]}
      />,
    )
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['Grand Blue Dreaming Season 3', 'Grand Blue Dreaming'])
    fireEvent.click(buttons[0])
    expect(open).toHaveBeenCalledWith('s3')
  })
})

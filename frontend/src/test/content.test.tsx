import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Kbd, Row, RowAction, Rows, SectionHeading, TextLink } from 'fluid-lycoris'

describe('SectionHeading', () => {
  it('is a sentence-case h2 with a red marker and the action at the right', () => {
    const { container } = render(<SectionHeading title="Braucht dich" action={<TextLink>Alle</TextLink>} />)
    const h = screen.getByRole('heading', { level: 2, name: 'Braucht dich' })
    expect(h).toHaveClass('t-sec-title', 't-wipe')
    expect(h).not.toHaveAttribute('data-tone')
    expect(container.firstElementChild).toHaveClass('t-sec-h')
    expect(screen.getByRole('button', { name: 'Alle' })).toHaveClass('t-link')
  })

  it('takes the teal marker and another level', () => {
    render(<SectionHeading title="Regeln" tone="accent-2" level={3} id="r" />)
    const h = screen.getByRole('heading', { level: 3, name: 'Regeln' })
    expect(h).toHaveAttribute('data-tone', 'accent-2')
    expect(h).toHaveAttribute('id', 'r')
  })
})

describe('TextLink', () => {
  it('is a link with href and a button without', () => {
    render(
      <>
        <TextLink href="/x">Woche</TextLink>
        <TextLink tone="accent-2" onClick={() => {}}>
          Warum?
        </TextLink>
      </>,
    )
    expect(screen.getByRole('link', { name: 'Woche' })).toHaveAttribute('href', '/x')
    const b = screen.getByRole('button', { name: 'Warum?' })
    expect(b).toHaveAttribute('type', 'button')
    expect(b).toHaveClass('t-link', 't-link--2')
  })
})

describe('Rows and Row', () => {
  it('renders a hairline list with title, sub line, glyph and action', () => {
    const act = vi.fn()
    const { container } = render(
      <Rows dense aria-label="Liste">
        <Row
          leading={<svg />}
          tone="err"
          title="One Piece"
          sub="Folge 1120 fehlt"
          trailing={<RowAction onClick={act}>Laden</RowAction>}
        />
      </Rows>,
    )
    expect(screen.getByRole('list', { name: 'Liste' })).toHaveClass('t-rows', 't-rows--dense')
    expect(container.querySelector('.t-glyph')).toHaveAttribute('data-tone', 'err')
    expect(screen.getByText('One Piece').tagName).toBe('STRONG')
    expect(screen.getByText('Folge 1120 fehlt')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Laden' }))
    expect(act).toHaveBeenCalled()
  })

  it('lets children replace the title block', () => {
    const { container } = render(
      <ul>
        <Row>
          <span>eigen</span>
        </Row>
      </ul>,
    )
    expect(container.querySelector('.t-row-t')).toBeNull()
    expect(screen.getByText('eigen')).toBeInTheDocument()
  })
})

describe('Kbd', () => {
  it('is a kbd element with the cap class', () => {
    render(<Kbd>Ctrl</Kbd>)
    const k = screen.getByText('Ctrl')
    expect(k.tagName).toBe('KBD')
    expect(k).toHaveClass('t-kbd')
  })
})

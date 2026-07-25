import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  Badge,
  Button,
  ButtonLabel,
  ButtonLink,
  buttonClass,
  Checkbox,
  Count,
  Divider,
  Field,
  FieldRow,
  IconButton,
  Input,
  Panel,
  ROW_GRID,
  Select,
  Surface,
  Tab,
  Tabs,
  Textarea,
  Toolbar,
} from '@weebsync/design-system'

// The design system is imported through the same alias the app uses, so these
// tests exercise the source the bundler actually ships.

describe('buttonClass', () => {
  it('defaults to the plain button with no modifier', () => {
    expect(buttonClass()).toBe('t-btn')
  })

  it('maps every variant to its modifier', () => {
    expect(buttonClass({ variant: 'default' })).toBe('t-btn')
    expect(buttonClass({ variant: 'primary' })).toBe('t-btn t-btn--primary')
    expect(buttonClass({ variant: 'danger' })).toBe('t-btn t-btn--danger')
  })

  it('adds the size modifier only for sm', () => {
    expect(buttonClass({ size: 'md' })).toBe('t-btn')
    expect(buttonClass({ size: 'sm' })).toBe('t-btn t-btn--sm')
  })

  it('adds t-cut for the clipped corner and keeps the extra className last', () => {
    expect(buttonClass({ variant: 'primary', size: 'sm', cut: true, className: 'w-full' })).toBe(
      't-btn t-btn--sm t-btn--primary t-cut w-full',
    )
  })

  it('drops falsy parts instead of leaving double spaces', () => {
    expect(buttonClass({ className: undefined })).toBe('t-btn')
  })
})

describe('Button', () => {
  it('is type=button by default, so it never submits a form by accident', () => {
    render(<Button>Speichern</Button>)
    expect(screen.getByRole('button', { name: 'Speichern' })).toHaveAttribute('type', 'button')
  })

  it('lets an explicit type win over the default', () => {
    render(<Button type="submit">Absenden</Button>)
    expect(screen.getByRole('button', { name: 'Absenden' })).toHaveAttribute('type', 'submit')
  })

  it('renders the same classes as buttonClass for the same options', () => {
    render(
      <Button variant="danger" size="sm" cut className="mt-2">
        Löschen
      </Button>,
    )
    const btn = screen.getByRole('button', { name: 'Löschen' })
    expect(btn.className).toBe(buttonClass({ variant: 'danger', size: 'sm', cut: true, className: 'mt-2' }))
  })

  it('forwards the remaining button attributes', () => {
    render(<Button disabled aria-describedby="hint">Warten</Button>)
    const btn = screen.getByRole('button', { name: 'Warten' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('aria-describedby', 'hint')
  })
})

describe('ButtonLink and ButtonLabel', () => {
  it('renders an anchor that carries the button classes', () => {
    render(
      <ButtonLink href="/docs" variant="primary">
        Doku
      </ButtonLink>,
    )
    const link = screen.getByRole('link', { name: 'Doku' })
    expect(link.tagName).toBe('A')
    expect(link).toHaveClass('t-btn', 't-btn--primary')
  })

  it('renders a real label so the wrapped file input keeps working', () => {
    const { container } = render(<ButtonLabel cut>Datei wählen</ButtonLabel>)
    const label = container.querySelector('label')
    expect(label).not.toBeNull()
    expect(label).toHaveClass('t-btn', 't-cut', 'cursor-pointer')
  })
})

describe('IconButton', () => {
  it('is a type=button carrying the icon class and its mandatory label', () => {
    render(
      <IconButton aria-label="Schließen">
        <svg />
      </IconButton>,
    )
    const btn = screen.getByRole('button', { name: 'Schließen' })
    expect(btn).toHaveAttribute('type', 'button')
    expect(btn).toHaveClass('t-iconbtn')
  })
})

describe('Input', () => {
  it('uses the md step by default and the modifier only for sm', () => {
    const { rerender } = render(<Input aria-label="Suche" />)
    expect(screen.getByLabelText('Suche')).toHaveClass('t-input')
    expect(screen.getByLabelText('Suche')).not.toHaveClass('t-input--sm')
    rerender(<Input aria-label="Suche" size="sm" />)
    expect(screen.getByLabelText('Suche')).toHaveClass('t-input', 't-input--sm')
  })

  it('does not leak the size step into the native size attribute', () => {
    // `size` is deliberately Omit-ed from the native props: it means character
    // width in HTML and a design-system step here, and forwarding it would
    // silently narrow the field.
    render(<Input aria-label="Suche" size="sm" />)
    expect(screen.getByLabelText('Suche')).not.toHaveAttribute('size')
  })

  it('appends the caller className after the design-system classes', () => {
    render(<Input aria-label="Suche" className="w-40" />)
    expect(screen.getByLabelText('Suche').className).toBe('t-input w-40')
  })
})

describe('Select', () => {
  it('wraps the select in the chevron span', () => {
    const { container } = render(
      <Select aria-label="Sortierung">
        <option value="a">A</option>
      </Select>,
    )
    const wrap = container.querySelector('.t-select-wrap')
    expect(wrap).not.toBeNull()
    expect(wrap).toHaveClass('block')
    expect(wrap?.firstElementChild).toBe(screen.getByRole('combobox'))
  })

  it('puts wrapperClassName on the wrapper and className on the select', () => {
    const { container } = render(
      <Select aria-label="Sortierung" wrapperClassName="w-32" className="uppercase">
        <option value="a">A</option>
      </Select>,
    )
    expect(container.querySelector('.t-select-wrap')).toHaveClass('w-32')
    expect(screen.getByRole('combobox')).toHaveClass('t-select', 'uppercase')
    expect(screen.getByRole('combobox')).not.toHaveClass('w-32')
  })

  it('sets the sm modifier without forwarding the native size attribute', () => {
    render(
      <Select aria-label="Sortierung" size="sm">
        <option value="a">A</option>
      </Select>,
    )
    const select = screen.getByRole('combobox')
    expect(select).toHaveClass('t-select', 't-select--sm')
    expect(select).not.toHaveAttribute('size')
  })

  it('renders its options as children of the select', () => {
    render(
      <Select aria-label="Sortierung" defaultValue="b">
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    )
    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(screen.getByRole('combobox')).toHaveValue('b')
  })
})

describe('Textarea', () => {
  it('shares the Input box and forwards the native textarea attributes', () => {
    render(<Textarea aria-label="Notiz" rows={4} className="font-mono" />)
    const area = screen.getByLabelText('Notiz')
    expect(area.tagName).toBe('TEXTAREA')
    expect(area).toHaveClass('t-input', 'font-mono')
    expect(area).toHaveAttribute('rows', '4')
  })

  it('carries the same size step as Input, and rows still sets the height', () => {
    render(<Textarea aria-label="Kompakt" size="sm" rows={2} />)
    const area = screen.getByLabelText('Kompakt')
    expect(area).toHaveClass('t-input', 't-input--sm')
    expect(area).toHaveAttribute('rows', '2')
  })
})

describe('Badge', () => {
  it('renders a span by default with the neutral tone class only', () => {
    render(<Badge>neu</Badge>)
    const badge = screen.getByText('neu')
    expect(badge.tagName).toBe('SPAN')
    expect(badge.className).toBe('t-label')
  })

  it.each([
    ['accent', 't-label--accent'],
    ['ok', 't-label--ok'],
    ['warn', 't-label--warn'],
    ['err', 't-label--err'],
  ] as const)('maps tone %s to %s', (tone, cls) => {
    render(<Badge tone={tone}>chip</Badge>)
    expect(screen.getByText('chip')).toHaveClass('t-label', cls)
  })

  it.each(['span', 'label', 'div', 'legend', 'a', 'h3', 'h4', 'button'] as const)(
    'renders as=%s as that very element',
    (as) => {
      render(<Badge as={as}>chip</Badge>)
      expect(screen.getByText('chip').tagName).toBe(as.toUpperCase())
    },
  )

  it('connects as="label" to its control through htmlFor', () => {
    render(
      <>
        <Badge as="label" htmlFor="filter">
          Filter
        </Badge>
        <input id="filter" />
      </>,
    )
    expect(screen.getByLabelText('Filter')).toBe(screen.getByRole('textbox'))
  })

  it('passes type and onClick through on as="button"', () => {
    const onClick = vi.fn()
    render(
      <Badge as="button" type="button" onClick={onClick}>
        2 Lücken
      </Badge>,
    )
    const chip = screen.getByRole('button', { name: '2 Lücken' })
    // without an explicit type the chip would submit a surrounding form
    expect(chip).toHaveAttribute('type', 'button')
    fireEvent.click(chip)
    expect(onClick).toHaveBeenCalled()
  })

  it('passes href, target and rel through on as="a"', () => {
    render(
      <Badge as="a" href="https://example.com" target="_blank" rel="noreferrer">
        AniList
      </Badge>,
    )
    const link = screen.getByRole('link', { name: 'AniList' })
    expect(link).toHaveAttribute('href', 'https://example.com')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
  })
})

describe('Panel', () => {
  it('is a div carrying t-panel by default', () => {
    const { container } = render(<Panel>Inhalt</Panel>)
    const panel = container.firstElementChild
    expect(panel?.tagName).toBe('DIV')
    expect(panel?.className).toBe('t-panel')
  })

  it.each(['div', 'section', 'form', 'article', 'aside', 'li'] as const)('renders as=%s', (as) => {
    const { container } = render(<Panel as={as}>Inhalt</Panel>)
    expect(container.firstElementChild?.tagName).toBe(as.toUpperCase())
  })

  it('adds the danger modifier and keeps the caller className', () => {
    const { container } = render(
      <Panel danger className="p-6">
        Gefahr
      </Panel>,
    )
    expect(container.firstElementChild).toHaveClass('t-panel', 't-panel--danger', 'p-6')
  })

  it('forwards element attributes such as the form handler target', () => {
    const { container } = render(<Panel as="form" id="settings" />)
    expect(container.querySelector('form')).toHaveAttribute('id', 'settings')
  })
})

describe('Checkbox', () => {
  it('renders a bare checkbox when no label is given', () => {
    const { container } = render(<Checkbox aria-label="Auswählen" className="accent-lime" />)
    const box = container.firstElementChild as HTMLInputElement
    expect(box.tagName).toBe('INPUT')
    expect(box.type).toBe('checkbox')
    expect(box).toHaveClass('accent-lime')
  })

  it('wraps box and text in a label when a label is given', () => {
    const { container } = render(<Checkbox label="Nur fehlende" defaultChecked />)
    const label = container.firstElementChild
    expect(label?.tagName).toBe('LABEL')
    expect(screen.getByLabelText('Nur fehlende')).toBeChecked()
  })

  it('puts labelClassName on the label and className on the box', () => {
    const { container } = render(<Checkbox label="Nur fehlende" labelClassName="truncate" className="shrink-0" />)
    expect(container.firstElementChild).toHaveClass('flex', 'items-center', 'truncate')
    expect(screen.getByLabelText('Nur fehlende')).toHaveClass('shrink-0')
    expect(screen.getByLabelText('Nur fehlende')).not.toHaveClass('truncate')
  })
})

describe('Field', () => {
  it('renders the caption and links it to the control via htmlFor', () => {
    render(
      <Field label="Zielordner" htmlFor="target">
        <Input id="target" />
      </Field>,
    )
    expect(screen.getByText('Zielordner')).toBeInTheDocument()
    expect(screen.getByLabelText('Zielordner')).toBe(screen.getByRole('textbox'))
  })

  it('still labels a nested control without htmlFor, and keeps the caption classes', () => {
    const { container } = render(
      <Field label="Muster" className="sm:col-span-2">
        <Input />
      </Field>,
    )
    expect(container.firstElementChild).toHaveClass('t-field', 'text-xs', 'sm:col-span-2')
    expect(screen.getByLabelText('Muster')).toBe(screen.getByRole('textbox'))
  })
})

describe('FieldRow', () => {
  it('renders the shared two-column grid', () => {
    const { container } = render(<FieldRow className="mt-4">x</FieldRow>)
    expect(container.firstElementChild?.className).toBe(`${ROW_GRID} mt-4`)
  })
})

describe('Divider', () => {
  it('shows the label chip and the count', () => {
    render(<Divider label="Server" count={3} />)
    expect(screen.getByText('Server')).toHaveClass('t-label', 't-label--accent')
    expect(screen.getByText('3')).toHaveClass('t-count')
  })

  it('renders a zero count instead of swallowing it', () => {
    render(<Divider label="Server" count={0} />)
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('renders no count element when the count is omitted', () => {
    const { container } = render(<Divider label="Server" />)
    expect(container.querySelector('.t-count')).toBeNull()
  })

  it('lets trailing replace the count entirely', () => {
    render(<Divider label="Server" count={3} trailing={<a href="/all">alle</a>} />)
    expect(screen.getByRole('link', { name: 'alle' })).toBeInTheDocument()
    expect(screen.queryByText('3')).toBeNull()
  })
})

describe('Surface, Toolbar, Tabs and Count', () => {
  it('sets the theme attribute and drops the padding when flush', () => {
    const { container, rerender } = render(<Surface theme="light">x</Surface>)
    expect(container.firstElementChild).toHaveAttribute('data-theme', 'light')
    expect(container.firstElementChild).toHaveClass('p-4')
    rerender(
      <Surface flush>
        x
      </Surface>,
    )
    expect(container.firstElementChild).not.toHaveAttribute('data-theme')
    expect(container.firstElementChild).not.toHaveClass('p-4')
  })

  it('renders the toolbar row', () => {
    const { container } = render(<Toolbar className="mb-2" />)
    expect(container.firstElementChild?.className).toBe('t-toolbar mb-2')
  })

  it('exposes the tablist and tab roles with the selected state', () => {
    render(
      <Tabs>
        <Tab selected>Alle</Tab>
        <Tab>Offen</Tab>
      </Tabs>,
    )
    expect(screen.getByRole('tablist')).toHaveClass('t-tabs')
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[0]).toHaveAttribute('type', 'button')
    // no `selected` means no aria-selected at all, not aria-selected="false"
    expect(tabs[1]).not.toHaveAttribute('aria-selected')
  })

  it('renders a tabular-number span', () => {
    render(<Count>42</Count>)
    expect(screen.getByText('42')).toHaveClass('t-count')
  })
})

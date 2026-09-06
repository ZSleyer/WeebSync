import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  ActionBar,
  AppBar,
  AppShell,
  Badge,
  Breadcrumb,
  CalendarDay,
  CalendarEntry,
  Cover,
  Disclosure,
  EmptyState,
  FileBrowser,
  FileRow,
  MediaCard,
  Menu,
  MenuItem,
  Modal,
  NavItem,
  navItemClass,
  Segmented,
  SuggestionCard,
} from '@weebsync/design-system'

describe('Cover', () => {
  it('renders the hatched placeholder and its children when there is no src', () => {
    const { container } = render(<Cover>?</Cover>)
    const box = container.firstElementChild
    expect(box?.tagName).toBe('DIV')
    expect(box).toHaveClass('t-hatch', 'h-20', 'w-14')
    expect(screen.getByText('?')).toBeInTheDocument()
  })

  it('renders an image in the same frame when a src is given', () => {
    render(<Cover src="/p.jpg" alt="Poster" size="sm" loading="lazy" />)
    const img = screen.getByRole('img', { name: 'Poster' })
    expect(img).toHaveAttribute('src', '/p.jpg')
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(img).toHaveClass('object-cover', 'h-14', 'w-10', 'shrink-0')
  })

  it('drops shrink-0 for the fill size, which stretches to its grid cell', () => {
    render(<Cover src="/p.jpg" size="fill" alt="Poster" />)
    const img = screen.getByRole('img', { name: 'Poster' })
    expect(img).toHaveClass('aspect-2/3', 'w-full')
    expect(img).not.toHaveClass('shrink-0')
  })

  it('leaves the image out of the accessibility tree without an alt text', () => {
    render(<Cover src="/p.jpg" />)
    expect(screen.queryByRole('img')).toBeNull()
  })
})

describe('MediaCard', () => {
  it('renders every optional slot when it is filled', () => {
    render(
      <MediaCard
        title="Detective Conan"
        path="remote -> lokal"
        pathTitle="voller Pfad"
        meta="zuletzt geprüft"
        badges={<Badge tone="ok">sync</Badge>}
        status={<span>12/24</span>}
        actions={<button type="button">Bearbeiten</button>}
      />,
    )
    expect(screen.getByRole('heading', { level: 3, name: 'Detective Conan' })).toBeInTheDocument()
    expect(screen.getByText('remote -> lokal')).toHaveAttribute('title', 'voller Pfad')
    expect(screen.getByText('zuletzt geprüft')).toBeInTheDocument()
    expect(screen.getByText('sync')).toBeInTheDocument()
    expect(screen.getByText('12/24')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bearbeiten' })).toBeInTheDocument()
  })

  it('omits the optional slots entirely when they are missing', () => {
    const { container } = render(<MediaCard title="Nur Titel" />)
    expect(container.querySelector('p')).toBeNull()
    expect(container.firstElementChild).toHaveClass('t-panel')
  })
})

describe('SuggestionCard', () => {
  it('renders the year behind the title and places the actions at the side', () => {
    const { container } = render(
      <SuggestionCard title="Frieren" year={2023} actions={<button type="button">Übernehmen</button>} />,
    )
    const heading = screen.getByRole('heading', { level: 4 })
    expect(heading).toHaveTextContent('Frieren (2023)')
    // "side" hangs the actions off the tile, not inside the text column
    expect(container.querySelector('.min-w-0')?.contains(screen.getByRole('button'))).toBe(false)
  })

  it('puts inline actions inside the text column', () => {
    const { container } = render(
      <SuggestionCard title="Frieren" actionsPlacement="inline" actions={<button type="button">Übernehmen</button>} />,
    )
    expect(container.querySelector('.min-w-0')?.contains(screen.getByRole('button'))).toBe(true)
  })

  it('switches the heading to the display face for upgrade tiles', () => {
    render(<SuggestionCard title="Frieren" titleStyle="display" />)
    expect(screen.getByRole('heading', { level: 4 })).toHaveClass('font-display')
  })

  it('renders no year span when the year is missing', () => {
    render(<SuggestionCard title="Frieren" />)
    expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent(/^Frieren$/)
  })
})

describe('CalendarDay and CalendarEntry', () => {
  it('renders the day heading with its entries', () => {
    render(
      <CalendarDay day="Freitag">
        <CalendarEntry title="Frieren" episode="Folge 12" time="17:00" countdown="in 2 h" />
      </CalendarDay>,
    )
    expect(screen.getByRole('heading', { level: 3, name: 'Freitag' })).toHaveClass('t-label', 't-label--accent')
    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.getByText('Frieren')).toBeInTheDocument()
    expect(screen.getByText('Folge 12')).toBeInTheDocument()
    expect(screen.getByText('17:00')).toBeInTheDocument()
    expect(screen.getByText('in 2 h')).toBeInTheDocument()
  })
})

describe('Breadcrumb', () => {
  it('always draws the root crumb first and navigates to the empty path', () => {
    const onNavigate = vi.fn()
    render(<Breadcrumb segments={[]} onNavigate={onNavigate} />)
    fireEvent.click(screen.getByRole('button', { name: '/' }))
    expect(onNavigate).toHaveBeenCalledWith('')
  })

  it('navigates to the path built from all segments up to the clicked one', () => {
    const onNavigate = vi.fn()
    render(<Breadcrumb segments={['anime', 'Detective Conan', 'Season 1']} onNavigate={onNavigate} />)
    fireEvent.click(screen.getByRole('button', { name: 'Detective Conan' }))
    expect(onNavigate).toHaveBeenCalledWith('anime/Detective Conan')
  })

  it('keeps a crumb click from reaching the edit hit area around it', () => {
    const onStartEdit = vi.fn()
    const onNavigate = vi.fn()
    render(<Breadcrumb segments={['anime']} onNavigate={onNavigate} onStartEdit={onStartEdit} />)
    fireEvent.click(screen.getByRole('button', { name: 'anime' }))
    expect(onNavigate).toHaveBeenCalledWith('anime')
    expect(onStartEdit).not.toHaveBeenCalled()
  })

  it('starts editing when the empty area next to the crumbs is clicked', () => {
    const onStartEdit = vi.fn()
    render(<Breadcrumb segments={['anime']} onStartEdit={onStartEdit} label="Pfad" />)
    fireEvent.click(screen.getByRole('navigation', { name: 'Pfad' }))
    expect(onStartEdit).toHaveBeenCalledTimes(1)
  })

  it('renders the trailing control', () => {
    render(<Breadcrumb segments={[]} trailing={<button type="button">Bearbeiten</button>} />)
    expect(screen.getByRole('button', { name: 'Bearbeiten' })).toBeInTheDocument()
  })
})

describe('FileRow and FileBrowser', () => {
  it('is a bare button when it has no actions', () => {
    const { container } = render(<FileRow name="Folge 1.mkv" detail="1,2 GiB" />)
    expect(container.firstElementChild?.tagName).toBe('BUTTON')
    expect(screen.getByText('1,2 GiB')).toBeInTheDocument()
  })

  it('wraps into a list item as soon as actions are given', () => {
    const { container } = render(<FileRow name="anime" actions={<button type="button">Wählen</button>} />)
    expect(container.firstElementChild?.tagName).toBe('LI')
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('marks the selected row and switches to the compact density', () => {
    render(<FileRow name="anime" selected density="compact" />)
    const row = screen.getByRole('button', { name: 'anime' })
    expect(row).toHaveClass('bg-bg-hover', 'text-accent', 'font-mono')
    expect(row).not.toHaveClass('text-t-secondary')
  })

  it('forwards click and double-click handlers', () => {
    const onClick = vi.fn()
    const onDoubleClick = vi.fn()
    render(<FileRow name="anime" onClick={onClick} onDoubleClick={onDoubleClick} />)
    const row = screen.getByRole('button', { name: 'anime' })
    fireEvent.click(row)
    fireEvent.doubleClick(row)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onDoubleClick).toHaveBeenCalledTimes(1)
  })

  it('shows the empty message instead of the rows', () => {
    render(
      <FileBrowser breadcrumb={<nav aria-label="Pfad" />} empty="Keine Einträge">
        <FileRow name="anime" />
      </FileBrowser>,
    )
    expect(screen.getByText('Keine Einträge')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'anime' })).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Pfad' })).toBeInTheDocument()
  })
})

describe('Menu and MenuItem', () => {
  it('exposes listbox and option roles with the selected state', () => {
    render(
      <Menu aria-label="Sortieren nach">
        <MenuItem selected trailing={<span>x</span>}>
          Name
        </MenuItem>
        <MenuItem trailing={<span>y</span>}>Datum</MenuItem>
      </Menu>,
    )
    expect(screen.getByRole('listbox', { name: 'Sortieren nach' })).toBeInTheDocument()
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[0]).toHaveClass('text-accent')
    expect(options[1]).toHaveClass('text-t-secondary')
  })

  it('shows the trailing mark on the selected item only', () => {
    render(
      <Menu aria-label="Sortieren nach">
        <MenuItem selected trailing={<span>haken</span>}>
          Name
        </MenuItem>
        <MenuItem trailing={<span>nicht sichtbar</span>}>Datum</MenuItem>
      </Menu>,
    )
    expect(screen.getByText('haken')).toBeInTheDocument()
    expect(screen.queryByText('nicht sichtbar')).toBeNull()
  })
})

describe('navItemClass and NavItem', () => {
  it('picks the active classes per variant', () => {
    expect(navItemClass('sidebar', true)).toContain('border-accent')
    expect(navItemClass('sidebar', false)).toContain('border-transparent')
    expect(navItemClass('bottomTab', true)).toContain('border-t-2')
    expect(navItemClass('sheet', true)).toContain('bg-bg-hover')
    expect(navItemClass('sheet', false, 'w-full')).toContain('w-full')
  })

  it('marks the active entry with aria-current', () => {
    render(
      <NavItem href="/watches" active>
        Watches
      </NavItem>,
    )
    const link = screen.getByRole('link', { name: 'Watches' })
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(link.className).toBe(navItemClass('sidebar', true))
  })

  it('leaves aria-current off an inactive entry', () => {
    render(<NavItem href="/watches">Watches</NavItem>)
    expect(screen.getByRole('link', { name: 'Watches' })).not.toHaveAttribute('aria-current')
  })

  it('carries the shell metrics so the app does not repeat them', () => {
    expect(navItemClass('bottomTab', false)).toContain('min-h-(--nav-h)')
    expect(navItemClass('row', true)).toContain('border-b')
    expect(navItemClass('row', false)).toContain('text-t-secondary')
  })

  it('renders as a button without aria-current when asked to', () => {
    render(
      <NavItem as="button" variant="bottomTab" active aria-haspopup="dialog">
        Mehr
      </NavItem>,
    )
    const btn = screen.getByRole('button', { name: 'Mehr' })
    expect(btn).toHaveAttribute('type', 'button')
    expect(btn).toHaveAttribute('aria-haspopup', 'dialog')
    expect(btn).not.toHaveAttribute('aria-current')
    expect(btn.className).toBe(navItemClass('bottomTab', true))
  })

  it('places the trailing slot at the right edge', () => {
    render(
      <NavItem variant="row" href="#" trailing={<span>chevron</span>}>
        Konto
      </NavItem>,
    )
    expect(screen.getByText('chevron').parentElement).toHaveClass('ml-auto')
  })
})

describe('Modal and EmptyState', () => {
  it('renders header, info, content and footer', () => {
    render(
      <Modal title="Watch bearbeiten" info="Serie 12" footer={<button type="button">Speichern</button>}>
        <p>Formular</p>
      </Modal>,
    )
    expect(screen.getByRole('heading', { level: 3, name: 'Watch bearbeiten' })).toBeInTheDocument()
    expect(screen.getByText('Serie 12')).toBeInTheDocument()
    expect(screen.getByText('Formular')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeInTheDocument()
  })

  it('omits the footer when there are no actions', () => {
    const { container } = render(<Modal title="Info">Text</Modal>)
    expect(container.querySelector('footer')).toBeNull()
  })

  it('renders the empty state on a panel with an optional chip', () => {
    const { container } = render(<EmptyState label="leer">Noch nichts hier</EmptyState>)
    expect(container.firstElementChild).toHaveClass('t-panel', 'text-center')
    expect(screen.getByText('leer')).toHaveClass('t-label', 't-label--accent')
    expect(screen.getByText('Noch nichts hier')).toBeInTheDocument()
  })
})

describe('AppBar and AppShell', () => {
  it('renders the three slots with the title as the page heading', () => {
    render(<AppBar leading={<span>mark</span>} title="Auto-Sync" actions={<button type="button">Sortieren</button>} />)
    expect(screen.getByRole('banner')).toHaveClass('lg:hidden')
    expect(screen.getByRole('heading', { level: 1, name: 'Auto-Sync' })).toHaveClass('truncate')
    expect(screen.getByText('mark')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sortieren' })).toBeInTheDocument()
  })

  it('lets free-form children replace the slots', () => {
    render(<AppBar title="ignored">custom</AppBar>)
    expect(screen.getByText('custom')).toBeInTheDocument()
    expect(screen.queryByRole('heading')).toBeNull()
  })

  it('places the notice row between main and the tab bar, and only when given', () => {
    const { container, rerender } = render(
      <AppShell bar={<AppBar title="A" />} tabs={<nav aria-label="Tabs" />}>
        Inhalt
      </AppShell>,
    )
    const shell = container.firstElementChild as HTMLElement
    expect([...shell.children].map((c) => c.tagName)).toEqual(['HEADER', 'MAIN', 'NAV'])
    rerender(
      <AppShell bar={<AppBar title="A" />} tabs={<nav aria-label="Tabs" />} notice={<p>Update</p>}>
        Inhalt
      </AppShell>,
    )
    expect([...shell.children].map((c) => c.tagName)).toEqual(['HEADER', 'MAIN', 'DIV', 'NAV'])
    expect(screen.getByText('Update')).toBeInTheDocument()
  })
})

describe('ActionBar, Disclosure and Segmented', () => {
  it('is a named toolbar that sticks to the bottom of the scroller', () => {
    render(
      <ActionBar aria-label="Auswahl">
        <button type="button">Pause</button>
      </ActionBar>,
    )
    const bar = screen.getByRole('toolbar', { name: 'Auswahl' })
    expect(bar).toHaveClass('sticky', '-bottom-4', 'lg:bottom-0')
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('folds its block on the native details element and reports toggles', () => {
    const onToggle = vi.fn()
    const { container } = render(
      <Disclosure title="Geplant" count={3} onToggle={onToggle}>
        <p>Inhalt</p>
      </Disclosure>,
    )
    const details = container.querySelector('details') as HTMLDetailsElement
    expect(details.open).toBe(true)
    expect(screen.getByRole('heading', { level: 3, name: 'Geplant' })).toBeInTheDocument()
    expect(screen.getByText('3')).toHaveClass('t-label')
    details.open = false
    fireEvent(details, new Event('toggle'))
    expect(onToggle).toHaveBeenCalledWith(false)
  })

  it('starts closed with defaultOpen false and wears the chip style when small', () => {
    const { container } = render(
      <Disclosure title="Serien" small defaultOpen={false}>
        <p>Inhalt</p>
      </Disclosure>,
    )
    expect((container.querySelector('details') as HTMLDetailsElement).open).toBe(false)
    expect(container.querySelector('summary > span')).toHaveClass('t-label', 't-label--accent')
    // closed: the block is not in the DOM at all
    expect(screen.queryByText('Inhalt')).toBeNull()
  })

  it('presses exactly the current option and reports the tapped one', () => {
    const onChange = vi.fn()
    render(
      <Segmented
        aria-label="Ansicht"
        value="list"
        onChange={onChange}
        options={[
          { value: 'list', label: 'Liste' },
          { value: 'calendar', label: 'K', 'aria-label': 'Kalender' },
        ]}
      />,
    )
    expect(screen.getByRole('group', { name: 'Ansicht' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Liste' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Liste' })).toHaveClass('t-btn--primary')
    const cal = screen.getByRole('button', { name: 'Kalender' })
    expect(cal).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(cal)
    expect(onChange).toHaveBeenCalledWith('calendar')
  })
})

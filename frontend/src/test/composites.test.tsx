import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  ActionBar,
  AppBar,
  AppShell,
  Badge,
  Breadcrumb,
  CalendarDay,
  CalendarEntry,
  DayScroller,
  DayTimeline,
  timelineGap,
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
  Sparkline,
  StatTile,
  TransferCard,
  TrendChart,
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
    expect(img).toHaveClass('object-cover', 'h-14', 'w-10', 'shrink-0', 'rounded-xs')
  })

  it('drops shrink-0 for the fill size, which stretches to its grid cell', () => {
    render(<Cover src="/p.jpg" size="fill" alt="Poster" />)
    const img = screen.getByRole('img', { name: 'Poster' })
    expect(img).toHaveClass('aspect-2/3', 'w-full')
    expect(img).not.toHaveClass('shrink-0')
    // flush with its tile, which clips it - no radius of its own
    expect(img).not.toHaveClass('rounded-xs')
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

describe('cover buttons', () => {
  it('makes the suggestion poster a named button when it has a target', () => {
    const open = vi.fn()
    render(<SuggestionCard title="Frieren" cover="/p.jpg" onCover={open} coverLabel="Details zu Frieren" />)
    fireEvent.click(screen.getByRole('button', { name: 'Details zu Frieren' }))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('leaves the suggestion poster a plain frame without a target', () => {
    render(<SuggestionCard title="Frieren" cover="/p.jpg" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('makes the transfer poster a named button in both densities', () => {
    const open = vi.fn()
    const { rerender } = render(
      <TransferCard cover="/p.jpg" title="Frieren" percent={0} progressLabel="x" onCover={open} coverLabel="Details zu Frieren" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Details zu Frieren' }))
    rerender(
      <TransferCard variant="row" cover="/p.jpg" title="Frieren" percent={0} progressLabel="x" onCover={open} coverLabel="Details zu Frieren" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Details zu Frieren' }))
    expect(open).toHaveBeenCalledTimes(2)
  })
})

describe('DayScroller', () => {
  const labels = { prev: 'Vorige Woche', next: 'Nächste Woche', today: 'Heute', strip: 'Tag wählen' }
  const days = [
    { key: '2026-09-15', weekday: 'Di', day: 15, today: true, count: 2 },
    { key: '2026-09-16', weekday: 'Mi', day: 16 },
    { key: '2026-09-17', weekday: 'Do', day: 17 },
  ]
  const scroller = (over: Partial<Parameters<typeof DayScroller>[0]> = {}) =>
    render(<DayScroller days={days} selected="2026-09-16" onSelect={() => {}} step={1} label="Mittwoch, 16.09." labels={labels} onNext={() => {}} {...over} />)

  it('presses the picked day, rings today and counts the releases', () => {
    const pick = vi.fn()
    scroller({ onSelect: pick })
    const group = screen.getByRole('group', { name: 'Tag wählen' })
    const [di, mi] = Array.from(group.querySelectorAll('button'))
    expect(mi).toHaveAttribute('aria-pressed', 'true')
    expect(di).toHaveAttribute('aria-pressed', 'false')
    expect(di).toHaveAttribute('aria-current', 'date')
    expect(di).toHaveTextContent('2')
    fireEvent.click(di)
    expect(pick).toHaveBeenCalledWith('2026-09-15')
  })

  it('keeps every control in place, disabled rather than gone', () => {
    scroller()
    // no way back and no way to today from here, but both still sit there
    expect(screen.getByRole('button', { name: 'Vorige Woche' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Heute' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Nächste Woche' })).toBeEnabled()
  })

  it('jumps a whole week with the arrows', () => {
    const next = vi.fn()
    const prev = vi.fn()
    scroller({ onNext: next, onPrev: prev })
    fireEvent.click(screen.getByRole('button', { name: 'Nächste Woche' }))
    fireEvent.click(screen.getByRole('button', { name: 'Vorige Woche' }))
    expect(next).toHaveBeenCalledTimes(1)
    expect(prev).toHaveBeenCalledTimes(1)
  })

  it('picks the middle day while the band is still moving, one tick per day', () => {
    const pick = vi.fn()
    const buzz = vi.fn()
    Object.defineProperty(navigator, 'vibrate', { value: buzz, configurable: true })
    scroller({ onSelect: pick })
    const band = document.querySelector('.t-dayband') as HTMLElement
    // jsdom lays nothing out, so the band and its cells get a geometry
    band.getBoundingClientRect = () => ({ left: 0, width: 150 }) as DOMRect
    Object.defineProperty(band, 'clientWidth', { value: 150, configurable: true })
    const cells = Array.from(band.querySelectorAll<HTMLElement>('[data-day]'))
    const place = (offset: number) => cells.forEach((c, i) => (c.getBoundingClientRect = () => ({ left: i * 50 - offset, width: 50 }) as DOMRect))
    // the day already in the middle is not a new pick
    place(0)
    fireEvent.scroll(band)
    expect(pick).not.toHaveBeenCalled()
    // one day travels past: picked while the band is still moving, one tick
    place(50)
    fireEvent.scroll(band)
    expect(pick).toHaveBeenLastCalledWith('2026-09-17')
    expect(buzz).toHaveBeenCalledTimes(1)
    // the same middle over again is neither a new pick nor a second tick
    fireEvent.scroll(band)
    expect(pick).toHaveBeenCalledTimes(1)
    expect(buzz).toHaveBeenCalledTimes(1)
    // and back the other way ticks again
    place(0)
    fireEvent.scroll(band)
    expect(pick).toHaveBeenLastCalledWith('2026-09-16')
    expect(buzz).toHaveBeenCalledTimes(2)
  })

  it('rolls the caption from the old day to the new one', async () => {
    const { rerender } = scroller()
    expect(screen.getByText('Mittwoch, 16.09.')).toBeInTheDocument()
    rerender(
      <DayScroller days={days} selected="2026-09-17" onSelect={() => {}} step={2} label="Donnerstag, 17.09." labels={labels} onNext={() => {}} />,
    )
    // both are on screen while the roll runs, the old one on its way out
    const slot = screen.getByText('Donnerstag, 17.09.').closest('.t-slot') as HTMLElement
    expect(slot).toHaveClass('t-slot--up')
    expect(slot).toHaveTextContent('Mittwoch, 16.09.')
    // a real animationend bubbles from the rolling half; testing-library's
    // default init does not, and React listens at the root
    await waitFor(() => expect(screen.queryByText('Mittwoch, 16.09.')).toBeNull())
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

describe('CalendarEntry compact', () => {
  it('keeps the small poster and stacks the text beside it for a narrow week column', () => {
    const { container } = render(<CalendarEntry compact title="Frieren" episode="Folge 3" time="14:00" countdown="in 2 Tg." cover="/p.jpg" />)
    expect(container.querySelector('img')).toHaveClass('h-14', 'w-10')
    expect(container.firstElementChild).toHaveClass('items-start')
    expect(screen.getByText('14:00').parentElement).toContainElement(screen.getByText('Frieren'))
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
    const list = screen.getByRole('listbox', { name: 'Sortieren nach' })
    expect(list).toBeInTheDocument()
    // rounded and clipped sideways, so an item's hover fill cannot poke past
    // the corners; upright it scrolls, so a long list keeps its first entries
    expect(list).toHaveClass('rounded-lg', 'overflow-x-clip', 'overflow-y-auto')
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

  it('opens as an anchored popover where the engine can show one', () => {
    // jsdom says yes to every CSS.supports question but has no popover; an
    // engine with both shows the list on mount
    const show = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'showPopover', { value: show, configurable: true })
    try {
      render(
        <Menu aria-label="Aktionen" anchor="--menu-a" placement="top-end">
          <MenuItem>Alle</MenuItem>
        </Menu>,
      )
      // jsdom's sheet hides a popover that was never shown for real
      const list = screen.getByRole('listbox', { hidden: true })
      expect(list).toHaveAttribute('aria-label', 'Aktionen')
      expect(list).toHaveAttribute('popover', 'manual')
      expect(list).toHaveAttribute('data-placement', 'top-end')
      expect(list).toHaveClass('t-menu', 't-pop--up')
      expect(list.style.positionAnchor).toBe('--menu-a')
      expect(list).not.toHaveClass('absolute')
      expect(show).toHaveBeenCalledOnce()
    } finally {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).showPopover
    }
  })

  it('falls back to the wrapper-positioned block without popover support', () => {
    render(
      <Menu aria-label="Aktionen" anchor="--menu-a" placement="bottom-end">
        <MenuItem>Alle</MenuItem>
      </Menu>,
    )
    const list = screen.getByRole('listbox', { name: 'Aktionen' })
    expect(list).not.toHaveAttribute('popover')
    expect(list).toHaveClass('absolute', 'top-full', 'right-0', 'w-max')
    expect(list).not.toHaveClass('t-menu')
  })

  it('stays a plain block without an anchor, for callers that place it', () => {
    render(
      <Menu aria-label="Aktionen">
        <MenuItem>Alle</MenuItem>
      </Menu>,
    )
    const list = screen.getByRole('listbox', { name: 'Aktionen' })
    expect(list).not.toHaveAttribute('popover')
    expect(list).not.toHaveClass('absolute', 't-menu')
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

  it('puts the footer row right above the tabs', () => {
    const { container } = render(
      <AppShell bar={<AppBar title="A" />} tabs={<nav aria-label="Tabs" />} notice={<p>Update</p>} footer={<div role="toolbar" aria-label="Aktionen" />}>
        Inhalt
      </AppShell>,
    )
    const shell = container.firstElementChild as HTMLElement
    expect([...shell.children].map((c) => c.getAttribute('aria-label') ?? c.tagName)).toEqual(['HEADER', 'MAIN', 'DIV', 'Aktionen', 'Tabs'])
  })
})

describe('ActionBar, Disclosure and Segmented', () => {
  it('is a named toolbar: a shell row on a phone, a panel footer or a bare row on desktop', () => {
    render(
      <ActionBar aria-label="Auswahl">
        <button type="button">Pause</button>
      </ActionBar>,
    )
    const bar = screen.getByRole('toolbar', { name: 'Auswahl' })
    expect(bar).toHaveClass('px-4', 'lg:sticky', 'lg:bottom-0')
    expect(bar).not.toHaveClass('sticky', 'lg:mt-4', 'lg:border')
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
    cleanup()
    render(
      <ActionBar aria-label="Speichern" sticky={false}>
        <button type="button">Save</button>
      </ActionBar>,
    )
    const save = screen.getByRole('toolbar', { name: 'Speichern' })
    expect(save).not.toHaveClass('lg:sticky')
    expect(save).toHaveClass('lg:border-0', 'lg:p-0')
    cleanup()
    render(
      <ActionBar aria-label="Auswahl" floating>
        <button type="button">Löschen</button>
      </ActionBar>,
    )
    expect(screen.getByRole('toolbar', { name: 'Auswahl' })).toHaveClass('lg:sticky', 'lg:w-fit', 'lg:mx-auto', 'lg:border')
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

describe('Sparkline', () => {
  it('is a named image drawing one point per value', () => {
    render(<Sparkline values={[1, 2, 3]} label="Speed, letzte Minute" />)
    const svg = screen.getByRole('img', { name: 'Speed, letzte Minute' })
    const line = svg.querySelector('polyline')!
    expect(line.getAttribute('points')!.split(' ')).toHaveLength(3)
    // the last sample sits at the right edge, the largest at the top
    expect(line.getAttribute('points')!.split(' ')[2]).toBe('96,1')
    expect(line).toHaveAttribute('stroke', 'currentColor')
  })

  it('draws nothing below two values but keeps its box', () => {
    render(<Sparkline values={[4]} label="Speed" />)
    const svg = screen.getByRole('img', { name: 'Speed' })
    expect(svg.querySelector('polyline')).toBeNull()
    expect(svg).toHaveAttribute('width', '96')
  })

  it('scales against the given ceiling', () => {
    render(<Sparkline values={[0, 5]} max={10} label="Speed" height={22} />)
    // 5 of 10 lands halfway between the 1px margins: 22 - 0.5 * 20 - 1
    expect(screen.getByRole('img').querySelector('polyline')!.getAttribute('points')!.split(' ')[1]).toBe('96,11')
  })
})

describe('StatTile', () => {
  it('shows caption, figure, detail and trend', () => {
    render(<StatTile label="Speed" value="2,4 MiB/s" detail="über 3 Downloads" trend={<span>trend</span>} />)
    expect(screen.getByText('Speed')).toHaveClass('t-label')
    expect(screen.getByText('2,4 MiB/s')).toHaveClass('font-mono')
    expect(screen.getByText('über 3 Downloads')).toBeInTheDocument()
    expect(screen.getByText('trend')).toBeInTheDocument()
  })

  it('spans two columns only when asked', () => {
    const { container, rerender } = render(<StatTile label="Speed" value="0" />)
    expect(container.firstElementChild).not.toHaveClass('sm:col-span-2')
    rerender(<StatTile wide label="Speed" value="0" />)
    expect(container.firstElementChild).toHaveClass('t-panel', 'sm:col-span-2')
  })
})

describe('TransferCard', () => {
  it('leads with the medium poster and a named full-size bar as the hero', () => {
    const { container } = render(
      <TransferCard cover="https://x/p.jpg" title="Frieren" percent={30} progressLabel="Fortschritt Frieren" active stats="1 / 4 GiB" />,
    )
    expect(container.querySelector('img')).toHaveClass('h-20', 'w-14')
    const bar = screen.getByRole('progressbar', { name: 'Fortschritt Frieren' })
    expect(bar).toHaveAttribute('aria-valuenow', '30')
    expect(bar).not.toHaveClass('t-progress--sm')
    expect(bar.firstElementChild).toHaveClass('t-progress-running')
    expect(screen.getByText('1 / 4 GiB')).toHaveClass('font-mono')
  })

  it('is a row at list density with the small poster and the thin bar', () => {
    const { container } = render(
      <TransferCard variant="row" cover="https://x/p.jpg" title="Frieren" percent={0} progressLabel="Fortschritt Frieren" />,
    )
    expect(container.querySelector('img')).toHaveClass('h-14', 'w-10')
    expect(screen.getByRole('progressbar')).toHaveClass('t-progress--sm')
    expect(container.firstElementChild).toHaveClass('p-3')
  })

  it('renders no poster frame without a cover', () => {
    const { container } = render(<TransferCard title="Frieren" percent={0} progressLabel="Fortschritt" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.t-hatch')).toBeNull()
  })

  it('places every slot and marks a selected card', () => {
    const { container } = render(
      <TransferCard
        selected
        leading={<span>box</span>}
        title="Frieren"
        subtitle="file.mkv"
        badges={<span>chip</span>}
        meta="2023 · Madhouse"
        trailing={<span>toggle</span>}
        actions={<span>pause</span>}
        percent={50}
        progressLabel="Fortschritt"
      >
        <span>details</span>
      </TransferCard>,
    )
    for (const text of ['box', 'file.mkv', 'chip', '2023 · Madhouse', 'toggle', 'pause', 'details']) {
      expect(screen.getByText(text)).toBeInTheDocument()
    }
    expect(container.firstElementChild).toHaveClass('bg-bg-hover')
    expect(container.firstElementChild!.tagName).toBe('ARTICLE')
  })
})

describe('TrendChart', () => {
  const props = { label: 'Speed', format: (v: number) => `${v} B/s`, formatAge: (s: number) => `${s}s`, startLabel: 'start', endLabel: 'now' }

  it('names the ceiling and the window ends, one point per value', () => {
    render(<TrendChart values={[1, 4, 2]} {...props} />)
    expect(screen.getByText('4 B/s')).toBeInTheDocument()
    expect(screen.getByText('start')).toBeInTheDocument()
    expect(screen.getByText('now')).toBeInTheDocument()
    const svg = screen.getByRole('img', { name: 'Speed' })
    expect(svg.querySelector('polyline')!.getAttribute('points')!.split(' ')).toHaveLength(3)
    expect(svg.querySelector('polygon')).not.toBeNull()
  })

  it('keeps a short history at the right end of a fixed window', () => {
    render(<TrendChart values={[1, 2, 3]} span={5} {...props} />)
    const pts = screen.getByRole('img').querySelector('polyline')!.getAttribute('points')!.split(' ')
    // slots 0..4 over 600 units: the three samples take slots 2, 3, 4
    expect(pts.map((p) => p.split(',')[0])).toEqual(['300', '450', '600'])
  })

  it('draws nothing below two values', () => {
    render(<TrendChart values={[3]} {...props} />)
    expect(screen.getByRole('img').querySelector('polyline')).toBeNull()
  })

  it('reads a sample out under the pointer and lets go on leave', () => {
    render(<TrendChart values={[1, 4, 2]} {...props} />)
    const svg = screen.getByRole('img')
    svg.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 72, right: 100, bottom: 72, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.pointerMove(svg, { clientX: 50 })
    expect(screen.getByText('4 B/s')).toBeInTheDocument()
    expect(screen.getByText('1s')).toBeInTheDocument()
    expect(svg.querySelector('line')).not.toBeNull()
    fireEvent.pointerLeave(svg)
    expect(screen.queryByText('1s')).toBeNull()
    expect(svg.querySelector('line')).toBeNull()
  })
})

describe('CalendarEntry as a button', () => {
  it('is one button around the whole tile when it opens something', () => {
    const onClick = vi.fn()
    render(<CalendarEntry title="Frieren" time="20:00" onClick={onClick} aria-label="Details zu Frieren" />)
    const btn = screen.getByRole('button', { name: 'Details zu Frieren' })
    expect(btn).toHaveTextContent('Frieren')
    expect(btn).toHaveTextContent('20:00')
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('stays a plain tile without a handler', () => {
    render(<CalendarEntry title="Frieren" time="20:00" />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('MediaCard cover button', () => {
  it('makes the poster a named button when given onCover, and nothing otherwise', () => {
    const onCover = vi.fn()
    const { rerender } = render(<MediaCard title="Frieren" cover="/c.jpg" onCover={onCover} coverLabel="Details zu Frieren" />)
    fireEvent.click(screen.getByRole('button', { name: 'Details zu Frieren' }))
    expect(onCover).toHaveBeenCalledTimes(1)
    rerender(<MediaCard title="Frieren" cover="/c.jpg" />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('DayTimeline', () => {
  const gapLabel = (m: number) => `${Math.round(m)}min`
  const at = (h: number) => Math.floor(new Date(2026, 8, 12, h, 0).getTime() / 1000)

  // the whole point of the axis: real time becomes height, but a quiet stretch
  // is folded away so a day still fits on a phone screen
  it('turns waiting into height and cuts a long wait short', () => {
    expect(timelineGap(0).height).toBe(10)
    expect(timelineGap(30).height).toBeGreaterThan(timelineGap(10).height)
    expect(timelineGap(30).cut).toBe(false)
    const long = timelineGap(600)
    expect(long.height).toBe(56)
    expect(long.cut).toBe(true)
    // a folded stretch never grows again, however long the wait
    expect(timelineGap(6000).height).toBe(long.height)
  })

  it('says how long a cut stretch really was', () => {
    render(<DayTimeline entries={[{ key: 'a', at: at(9), node: <span>A</span> }, { key: 'b', at: at(20), node: <span>B</span> }]} gapLabel={gapLabel} />)
    expect(screen.getByText('660min')).toBeTruthy()
  })

  // the marker sits between the releases it has passed and the ones still
  // ahead, so it drifts down the axis as the clock runs
  it('drops the now marker into place by time', () => {
    const { container } = render(
      <DayTimeline
        entries={[{ key: 'a', at: at(9), node: <span>A</span> }, { key: 'b', at: at(20), node: <span>B</span> }]}
        now={at(12) * 1000}
        nowLabel="Jetzt 12:00"
        gapLabel={gapLabel}
      />,
    )
    const rows = [...container.querySelectorAll('.t-timeline__row, .t-timeline__now')]
    expect(rows.map((r) => r.textContent || 'NOW')).toEqual(['A', 'NOW', 'B'])
    expect(screen.getByLabelText('Jetzt 12:00')).toBeTruthy()
  })

  it('leaves the marker out on any day but today', () => {
    const { container } = render(<DayTimeline entries={[{ key: 'a', at: at(9), node: <span>A</span> }]} gapLabel={gapLabel} />)
    expect(container.querySelector('.t-timeline__now')).toBeNull()
  })
})

import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, BookOpen, Compass, FolderOpen, House, RefreshCw, Search, Settings } from 'lucide-react'
import {
  createBrowserRouter,
  createRoutesFromElements,
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  useLocation,
  useMatches,
  useNavigationType,
} from 'react-router'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AppShell, enterPage, Kbd, TabBar, useMediaQuery } from 'fluid-lycoris'
import { api, type Download } from './api'
import { updateText, useAuth, useEvents, useKeyboardUp, useUpdateHint } from './hooks'
import Brand from './components/Brand'
import Logo from './components/Logo'
import { useSpeedSampler } from './speedHistory'
import Loading from './components/Loading'
import UpdateToast from './components/UpdateToast'
import Tips from './components/Tips'
import ScrollMemory from './components/ScrollMemory'
import PageScroll from './components/PageScroll'
import CommandPalette from './components/CommandPalette'
import { LiveActivity } from './components/LiveActivity'
import PhoneHint from './components/PhoneHint'
import { TransfersProvider } from './components/TransferSheet'
import { AudioProvider, MiniPlayer } from './components/AudioPlayer'
import { useBack } from './components/playLinks'
import { browserAnimated, RouteTransition, routeMotion, SectionMotion, topPage } from './components/RouteTransition'
import RedirectWithQuery from './components/RedirectWithQuery'
import { AppBarActions, ShellFooter, ShellToolbar, TitleActions, WIDE_MQ } from './components/PageActions'
import { LiveProvider } from './components/liveState'
import { SeriesModalProvider, TITLE_PATH, useSeriesModal } from './components/SeriesModal'
import Setup, { FINISHING_KEY } from './pages/Setup'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import History from './pages/History'
import Files from './pages/Files'
import Trash from './pages/Trash'
import Watches from './pages/Watches'
import SuggestionsLayout, {
  BucketSection,
  DuplicatesSection,
  IgnoredSection,
  UpgradesSection,
} from './pages/Suggestions'
import { DiscoverIndex, LegacySuggestions } from './components/DiscoverRedirect'
import { DISCOVER_BASE, discoverPath, slugOf } from './discoverRoutes'
import Assistant from './pages/Assistant'
import Rename from './pages/Rename'
import SettingsLayout, { AdminRoute, SettingsHub } from './pages/settings/SettingsLayout'
import SyncDefaults from './pages/settings/SyncDefaults'
import Rules from './pages/settings/Rules'
import General from './pages/settings/General'
import About from './pages/settings/About'
import Servers from './pages/settings/Servers'
import Account from './pages/settings/Account'
import Notifications from './pages/settings/Notifications'
import Transfers from './pages/settings/Transfers'
import Security from './pages/settings/Security'
import Integrations from './pages/settings/Integrations'
import Jobs from './pages/settings/Jobs'
import Matching, { MatchesPage } from './pages/settings/Matching'
import Data, { StorePage } from './pages/settings/Data'

// Four pages, the same on every device - no "more" sheet: a menu behind a
// button is found half as often as one in sight. The calendar is a view of
// Auto-Sync, the phone's last tab is the search, under the thumb. Settings is
// the gear in the app bar (phone) and the foot of the sidebar (desktop);
// Rename is a tool on a folder, reached from Files.
// motion: how the icon moves once as its page becomes the current one (see
// .t-nav-icon in index.css): the house hops, the arrows turn, the needle
// swings, the folder opens up
const TABS = [
  { to: '/', key: 'nav.dashboard', icon: House, motion: 'hop' },
  { to: '/watches', key: 'nav.watches', icon: RefreshCw, motion: 'turn' },
  { to: DISCOVER_BASE, key: 'nav.suggestions', icon: Compass, motion: 'needle' },
  { to: '/files', key: 'nav.files', icon: FolderOpen, motion: 'open' },
]
const PHONE_TABS = TABS
// the rules sit beside settings on a desktop: read more often than the rest
const RULES = { to: '/rules', key: 'nav.rules', icon: BookOpen, motion: 'open' }
const SETTINGS = { to: '/settings', key: 'nav.settings', icon: Settings, motion: 'turn' }
const NAV = [...TABS, SETTINGS]
// the sync side of the colour code: their entries light up teal, not red
const TEAL = ['/watches', '/files']
// how long a page's entry runs (the last wipe and the widest rise) before
// its mark comes off
const ENTER_MS = 1200
type NavEntry = (typeof NAV)[number]
const onPath = (n: NavEntry, path: string) => path === n.to || (n.to !== '/' && path.startsWith(n.to + '/'))

// Files keeps its folder in state and writes it to the URL itself, so a link
// into it from the search would be written over. A jump (navigation state
// from the search) mounts it afresh, and it starts from the link.
function FilesJump() {
  const { state } = useLocation()
  return <Files key={(state as { jump?: number } | null)?.jump ?? 0} />
}

// Root layout element of the data router. A data router (createBrowserRouter)
// is required so form pages can useBlocker() to guard unsaved changes.
function RootLayout() {
  const { data: user, isLoading } = useAuth()
  useEvents(!!user)
  useSpeedSampler(!!user)

  if (isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Loading />
      </div>
    )
  }
  if (!user) return <Login />
  if (user.isAdmin) return <AdminGate email={user.email} />
  return <Shell email={user.email} />
}

// The OIDC-only setup path has no account until the first OIDC login, so the
// wizard cannot run its later steps inline - it navigates away and picks up
// here on the way back, at the same step list it left off at. Instances that
// already have a server report onboardingDone, so upgrades never see this.
function AdminGate({ email }: { email: string }) {
  const qc = useQueryClient()
  const { data } = useQuery<{ onboardingDone?: boolean }>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
  })
  // leaving the closing step: the settings already say done, so their refetch
  // changes nothing and would not render this again; the click does
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  // the wizard's closing step outlives the save that marks onboarding done
  if (data?.onboardingDone === false || sessionStorage.getItem(FINISHING_KEY))
    return (
      <Setup
        initialStep="import"
        onDone={() => {
          rerender()
          void qc.invalidateQueries({ queryKey: ['settings'] })
        }}
      />
    )
  return <Shell email={email} />
}

/** Route meta the shell reads through useMatches(): the title key of a screen
 *  and, on a stacked screen, where its back link goes. */
export interface RouteHandle {
  title?: string
  /** where the app bar's back link goes */
  back?: string
  /** the section this screen belongs to, for the document title */
  section?: string
  /** a screen opened from many places goes back where it came from; `back`
   *  is then only where a direct link leads */
  backHistory?: boolean
  /** a full-screen media view (player, reader): on a phone the shell's bars,
   *  its notice row and the live pill step aside, and no route motion is
   *  left on the page; a desktop keeps its sidebar */
  immersive?: boolean
}
const h = (title: string, back?: string, section?: string): RouteHandle => ({ title, back, section })
const inSettings = (title: string) => h(title, '/settings', 'nav.settings')
// every section of Entdecken is a tab of one page, none stacked on another
const discoverTab = (title: string) => h(title, undefined, 'nav.suggestions')

export const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<RootLayout />}>
      <Route path="/" element={<Dashboard />} handle={h('nav.dashboard')} />
      {/* a title card's own URL, opened from a link or a reload: the card
          stands over the dashboard (SeriesModalProvider reads the path) */}
      <Route path={TITLE_PATH} element={<Dashboard />} handle={h('nav.dashboard')} />
      <Route path="/files" element={<FilesJump />} handle={h('nav.files')} />
      {/* the remote and local browsers merged into /files; their links keep
          the folder they pointed at */}
      <Route path="/remote" element={<RedirectWithQuery to="/files" />} />
      <Route path="/local" element={<RedirectWithQuery to="/files" rewrite={(p) => (p.set('source', 'local'), p)} />} />
      <Route path="/browser" element={<RedirectWithQuery to="/files" />} />
      <Route
        path="/calendar"
        element={<RedirectWithQuery to="/watches" rewrite={(p) => (p.set('view', 'calendar'), p)} />}
      />
      <Route path="/history" element={<History />} handle={h('history.title', '/', 'nav.dashboard')} />
      <Route path="/watches" element={<Watches />} handle={h('nav.watches')} />
      {/* Entdecken: every section a tab of one page, the assistant and the
          ignored items included; the index opens the last one used */}
      <Route path={DISCOVER_BASE} element={<SuggestionsLayout />} handle={h('nav.suggestions')}>
        <Route index element={<DiscoverIndex />} />
        <Route
          path={slugOf('watchlist')}
          element={<BucketSection bucket="watchlist" />}
          handle={discoverTab('suggestions.tabWatchlist')}
        />
        <Route
          path={slugOf('recommended')}
          element={<BucketSection bucket="recommended" />}
          handle={discoverTab('suggestions.tabRecommended')}
        />
        <Route
          path={slugOf('trending')}
          element={<BucketSection bucket="trending" />}
          handle={discoverTab('suggestions.tabTrending')}
        />
        <Route
          path={slugOf('upgrades')}
          element={<UpgradesSection />}
          handle={discoverTab('suggestions.tabUpgrades')}
        />
        <Route
          path={slugOf('incomplete')}
          element={<BucketSection bucket="incomplete" />}
          handle={discoverTab('suggestions.tabIncomplete')}
        />
        <Route
          path={slugOf('duplicates')}
          element={<DuplicatesSection />}
          handle={discoverTab('suggestions.tabDuplicates')}
        />
        <Route path={slugOf('ignored')} element={<IgnoredSection />} handle={discoverTab('suggestions.ignored')} />
        <Route path={slugOf('assistant')} element={<Assistant />} handle={discoverTab('nav.assistant')} />
        <Route path="*" element={<Navigate to={DISCOVER_BASE} replace />} />
      </Route>
      {/* the old addresses of the same screens */}
      <Route path="/suggestions/*" element={<LegacySuggestions />} />
      <Route path="/assistant" element={<Navigate to={discoverPath('assistant')} replace />} />
      <Route path="/plex" element={<Navigate to={DISCOVER_BASE} replace />} />
      <Route path="/servers" element={<Navigate to="/settings/servers" replace />} />
      <Route path="/rename" element={<Rename />} handle={h('nav.rename', '/files', 'nav.files')} />
      <Route path="/files/trash" element={<Trash />} handle={h('trash.title', '/files', 'nav.files')} />
      {/* lazy: libass, hls.js and the player controls are megabytes nobody
          else needs */}
      <Route
        path="/play"
        lazy={() => import('./pages/Player').then((m) => ({ Component: m.default }))}
        handle={{ ...h('player.title', '/files', 'nav.files'), backHistory: true, immersive: true }}
      />
      {/* lazy as well: the readers and pdf.js only load when a file is opened */}
      <Route
        path="/view"
        lazy={() => import('./pages/Viewer').then((m) => ({ Component: m.default }))}
        handle={{ ...h('viewer.title', '/files', 'nav.files'), backHistory: true, immersive: true }}
      />
      {/* the rules have a page of their own, reached from the sidebar and
          from settings; on a phone it stacks on settings */}
      <Route
        path={RULES.to}
        element={<Rules />}
        handle={{ title: 'settings.nav.rules', back: '/settings', backHistory: true }}
      />
      <Route path="/settings" element={<SettingsLayout />} handle={h('nav.settings')}>
        <Route index element={<SettingsHub />} />
        <Route path="general" element={<General />} handle={inSettings('settings.nav.general')} />
        <Route path="look" element={<Navigate to="/settings/general" replace />} />
        <Route path="about" element={<About />} handle={inSettings('settings.nav.about')} />
        <Route path="account" element={<Account />} handle={inSettings('settings.nav.account')} />
        <Route path="sync" element={<SyncDefaults />} handle={inSettings('settings.nav.sync')} />
        <Route path="rules" element={<RedirectWithQuery to="/rules" />} />
        <Route path="notifications" element={<Notifications />} handle={inSettings('settings.nav.notifications')} />
        <Route path="servers" element={<Servers />} handle={inSettings('nav.servers')} />
        <Route
          path="transfers"
          element={
            <AdminRoute>
              <Transfers />
            </AdminRoute>
          }
          handle={inSettings('settings.nav.transfers')}
        />
        <Route
          path="security"
          element={
            <AdminRoute>
              <Security />
            </AdminRoute>
          }
          handle={inSettings('settings.nav.security')}
        />
        <Route
          path="integrations"
          element={
            <AdminRoute>
              <Integrations />
            </AdminRoute>
          }
          handle={inSettings('settings.nav.integrations')}
        />
        <Route
          path="jobs"
          element={
            <AdminRoute>
              <Jobs />
            </AdminRoute>
          }
          handle={inSettings('settings.nav.jobs')}
        />
        <Route
          path="matching"
          element={
            <AdminRoute>
              <Matching />
            </AdminRoute>
          }
          handle={inSettings('settings.nav.matching')}
        />
        <Route
          path="matching/:server/:source"
          element={
            <AdminRoute>
              <MatchesPage />
            </AdminRoute>
          }
          handle={h('settings.nav.matching', '/settings/matching', 'nav.settings')}
        />
        <Route
          path="data"
          element={
            <AdminRoute>
              <Data />
            </AdminRoute>
          }
          handle={inSettings('settings.nav.data')}
        />
        <Route
          path="data/:store"
          element={
            <AdminRoute>
              <StorePage />
            </AdminRoute>
          }
          handle={h('settings.nav.data', '/settings/data', 'nav.settings')}
        />
        {/* merged sections: the old paths land on their panel */}
        <Route path="email" element={<Navigate to="/settings/integrations#email" replace />} />
        <Route path="users" element={<Navigate to="/settings/security#users" replace />} />
        <Route path="import" element={<Navigate to="/settings/data#import" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>,
  ),
)

/** The deepest matched route that carries a title - the screen the user is on. */
export function useScreen(): RouteHandle {
  const matches = useMatches()
  for (let i = matches.length - 1; i >= 0; i--) {
    const handle = matches[i].handle as RouteHandle | undefined
    if (handle?.title) return handle
  }
  return {}
}

// document.title per route (WCAG 2.4.2). A stacked screen names its parent
// in the middle so a tab reads "Notifications - Settings - WeebSync".
function RouteTitle() {
  const { t } = useTranslation()
  const { title, section } = useScreen()
  useEffect(() => {
    const parts = [title && t(title), section && t(section), 'WeebSync'].filter(Boolean)
    document.title = parts.join(' - ')
  }, [title, section, t])
  return null
}

// The live activity's finished state, kept above the page that remounts,
// with the way into the series of what landed
function LiveBridge({ children }: { children: ReactNode }) {
  const series = useSeriesModal()
  return <LiveProvider openSeries={series.open}>{children}</LiveProvider>
}

function Shell({ email }: { email: string }) {
  const { t } = useTranslation()
  // the tab bar would ride on top of the keyboard and eat a sixth of what it
  // leaves of the screen; it steps aside while typing, as native apps do
  const keyboard = useKeyboardUp()
  const location = useLocation()
  const { title, back, backHistory, immersive: fullScreen } = useScreen()
  const goBack = useBack(back ?? '/')
  // the header mark lights up while something transfers; same query the
  // sampler keeps alive, so this costs no extra request
  const { data: transferring = false } = useQuery({
    queryKey: ['downloads'],
    queryFn: () => api.get<Download[]>('/api/downloads'),
    select: (ds) => ds.some((d) => d.status === 'running'),
  })
  // the app bar's actions slot, handed to pages through context; held in
  // state (not a ref) so a page mounting before the bar still portals in
  const [actions, setActions] = useState<HTMLElement | null>(null)
  // the shell's footer row, same deal: a page's action bar portals in
  const [footer, setFooter] = useState<HTMLElement | null>(null)
  // beside <main> on a desktop: where the title card docks
  const [aside, setAside] = useState<HTMLElement | null>(null)
  const [palette, setPalette] = useState(false)
  // a newer build out: a dot on the Settings entry (the gear on a phone) and
  // a line in the rail's foot, so an admin sees it without opening Settings;
  // the About panel has the details
  const update = useUpdateHint()
  const updateLine = update && updateText(t, update)

  // How the screen changes, decided once per navigation (a plain re-render
  // must not replay it). <main> is keyed on the top-level page, so it only
  // remounts - and animates - when the page changes; a move inside a page
  // (a settings section, a discover section) animates the section's own
  // outlet and leaves its heading, menu and tabs standing. A back swipe the
  // browser already animated plays nothing on top.
  const wide = useMediaQuery(WIDE_MQ)
  // a full-screen media view on a phone: the page is all there is
  const immersive = !!fullScreen && !wide
  // the phone's toolbar slot (a selection's actions) and the actions slot of
  // the desktop title row, both held in state like the app bar's
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null)
  const [titleActions, setTitleActions] = useState<HTMLElement | null>(null)
  const titleRow = wide && !back
  const navType = useNavigationType()
  const prev = useRef({ path: location.pathname, back })
  const motion = useMemo(() => {
    const m = routeMotion(prev.current, { path: location.pathname, back }, wide, navType === 'REPLACE')
    prev.current = { path: location.pathname, back }
    return navType === 'POP' && browserAnimated() ? { page: '', section: '' } : m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  // Entering a page or one of its sections: the title and the section
  // headings wipe in, the rows rise in one wave (enterPage). Played once per
  // path, not per query: Files writes its search field to the URL, and a
  // switch inside a page is the page's own useEnterPage call. The mark is
  // taken off again once it ran, so a polled list that remounts its rows
  // later does not rise a second time.
  const barTitle = useRef<HTMLSpanElement>(null)
  const deskTitle = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const main = document.querySelector<HTMLElement>('.app-shell > main')
    if (!main) return
    const extra = [barTitle.current, deskTitle.current].filter((e): e is HTMLSpanElement => !!e)
    // only once the new route has painted (two frames): starting the entry
    // in the same frame as the mount made the first frames drop on a phone
    let id: ReturnType<typeof setTimeout> | undefined
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        enterPage(main, extra)
        id = setTimeout(() => [main, ...extra].forEach((e) => e.removeAttribute('data-wipe')), ENTER_MS)
      })
    })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(id)
    }
  }, [location.pathname])

  // No sideways swipe between the pages: it fought every horizontal gesture
  // inside them (row swipes, the calendar, the tab decks) and was the least
  // reliable of them. The tab bar is one tap away.

  // red for Heute and Entdecken, teal for the sync side: Auto-Sync, Dateien
  const tone = (n: NavEntry) => (TEAL.includes(n.to) ? 'teal' : undefined)
  const icon = (n: NavEntry) => <n.icon aria-hidden className="t-nav-icon" data-nav={n.motion} />
  // the dot sits on the icon's corner, so it works in a row and in a stacked tab
  const dotted = (node: ReactNode, show: boolean) =>
    show ? (
      <span className="ws-dot">
        {node}
        <i aria-hidden />
        <span className="sr-only">{t('app.updateHint')}</span>
      </span>
    ) : (
      node
    )
  const screenTitle = title ? t(title) : 'WeebSync'

  const settingsOpen = onPath(SETTINGS, location.pathname)
  const sidebar = (
    <aside className="ws-side" aria-label={t('nav.side')}>
      <div className="ws-brand">
        {/* the mark is the way home from anywhere, as on every site */}
        <Link to="/" className="rounded-xs" aria-label={t('nav.dashboard')}>
          {/* folds into the mark and back out on every page change */}
          <Brand variant="rail" slogan={t('app.tagline')} replayKey={location.pathname} className="mt-3 mb-2" />
        </Link>
      </div>
      {/* the way into the palette, and where its shortcut is learnt */}
      <button type="button" onClick={() => setPalette(true)} aria-haspopup="dialog" className="ws-palette">
        <Search aria-hidden size="1.125rem" className="shrink-0" />
        <span>{t('palette.title')}</span>
        <Kbd>{`${/Mac|iP/.test(navigator.platform) ? '⌘' : t('palette.ctrl')} K`}</Kbd>
      </button>
      <nav className="ws-side-nav" aria-label={t('nav.main')}>
        {TABS.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className="ws-side-link" data-tone={tone(n)}>
            {icon(n)}
            {t(n.key)}
          </NavLink>
        ))}
      </nav>
      {/* settings at the foot, apart from the pages: visited rarely, but
          always in the same place; above them what transfers right now */}
      <div className="ws-side-foot">
        <MiniPlayer variant="rail" />
        <LiveActivity variant="rail" />
        <PhoneHint />
        <NavLink to={RULES.to} className="ws-side-link">
          {icon(RULES)}
          {t(RULES.key)}
        </NavLink>
        <Link to={SETTINGS.to} aria-current={settingsOpen ? 'page' : undefined} className="ws-side-link">
          {dotted(icon(SETTINGS), !!update)}
          {t(SETTINGS.key)}
        </Link>
        {update && (
          <Link to="/settings/about" className="ws-update">
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-warn" />
            <span className="min-w-0 truncate">{updateLine}</span>
          </Link>
        )}
        {/* who is signed in; signing out lives in the account card in settings */}
        <p className="ws-who" title={email}>
          {email}
        </p>
      </div>
    </aside>
  )

  // the phone's top bar: back link on a stacked screen, else the small mark;
  // the screen title as the page's h1 (no large title in the page), and the
  // slot pages fill with their secondary controls
  const bar = (
    <header className="ws-top">
      {back ? (
        <Link
          to={back}
          aria-label={t('nav.back')}
          className="ws-iconbtn -ml-2"
          onClick={(e) => {
            if (!backHistory) return
            e.preventDefault()
            goBack()
          }}
        >
          <ArrowLeft aria-hidden />
        </Link>
      ) : (
        <Link to="/" aria-label={t('nav.dashboard')} className="ws-top-mark">
          <Logo replayKey={location.pathname} className="h-5 w-auto" active={transferring} />
        </Link>
      )}
      <h1 className="min-w-0 flex-1 truncate">
        <span ref={barTitle} className="t-appbar-title">
          {screenTitle}
        </span>
      </h1>
      <div ref={setActions} className="flex items-center gap-1" />
      {/* the gear on every top-level page; a stacked screen has its back
          link instead, and Settings itself needs no way into itself */}
      {!back && !onPath(SETTINGS, location.pathname) && (
        <Link to={SETTINGS.to} aria-label={t(SETTINGS.key)} className="ws-iconbtn">
          {dotted(<Settings aria-hidden />, !!update)}
        </Link>
      )}
      {/* how far the page below has been read; PageScroll moves it */}
      <span aria-hidden className="t-scroll-line" />
    </header>
  )

  // the phone's tab bar: every top-level page, then the search
  const tabs = (
    <>
      {/* a page's toolbar stands in for the tabs while it holds something */}
      <div ref={setToolbar} className="ws-toolbar" hidden={keyboard} />
      <TabBar aria-label={t('nav.main')} hidden={keyboard}>
        <div className="ws-tabs">
          {PHONE_TABS.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className="ws-tab" data-tone={tone(n)}>
              <span aria-hidden className="ws-pip" />
              {icon(n)}
              <span>{t(n.key)}</span>
            </NavLink>
          ))}
          {/* the search as Ctrl+K is on the desktop: the last entry, where the
            thumb rests, drawn like the tabs but opening the search */}
          <button type="button" onClick={() => setPalette(true)} aria-haspopup="dialog" className="ws-tab">
            <span aria-hidden className="ws-pip" />
            <Search aria-hidden />
            <span>{t('palette.title')}</span>
          </button>
        </div>
      </TabBar>
    </>
  )

  return (
    <AudioProvider>
      <SectionMotion.Provider value={immersive ? '' : motion.section}>
        <AppBarActions.Provider value={actions}>
          <TitleActions.Provider value={titleRow ? titleActions : undefined}>
            <ShellToolbar.Provider value={toolbar}>
              <ShellFooter.Provider value={footer}>
                <SeriesModalProvider panel={aside}>
                  <TransfersProvider panel={aside}>
                    <LiveBridge>
                      <AppShell
                        className={immersive ? 'ws-immersive' : undefined}
                        sidebar={sidebar}
                        bar={immersive ? null : bar}
                        tabs={immersive ? null : tabs}
                        mainKey={topPage(location.pathname)}
                        notice={
                          immersive ? null : (
                            <>
                              <UpdateToast />
                              <MiniPlayer variant="pill" />
                            </>
                          )
                        }
                        footer={<div ref={setFooter} className="t-shell-footer shrink-0 empty:hidden lg:hidden" />}
                        aside={<div ref={setAside} className="contents" />}
                        before={
                          <>
                            <RouteTitle />
                            <ScrollMemory />
                            <CommandPalette pages={NAV} open={palette} onOpenChange={setPalette} />
                          </>
                        }
                      >
                        {/* the desktop's title row: a top-level page's h1 over the
                      content; a stacked screen keeps its own heading. Only
                      rendered wide: on a phone the pull to refresh moves the
                      first thing in <main> */}
                        {titleRow && (
                          <header className="ws-title">
                            <h1>
                              <span ref={deskTitle}>{screenTitle}</span>
                            </h1>
                            <div ref={setTitleActions} className="ws-title-acts" />
                          </header>
                        )}
                        {/* at most one one-time hint, above whatever page is open */}
                        <Tips />
                        {/* no transform left on the page under a full-screen view:
                      it would be the containing block of its fixed overlay */}
                        <RouteTransition cls={immersive ? '' : motion.page}>
                          <Outlet />
                        </RouteTransition>
                        <PageScroll stacked={!!back} />
                        {/* what transfers right now, riding the page's bottom edge */}
                        {!wide && !immersive && (
                          <div className="ws-live-wrap">
                            <LiveActivity variant="pill" />
                          </div>
                        )}
                      </AppShell>
                    </LiveBridge>
                  </TransfersProvider>
                </SeriesModalProvider>
              </ShellFooter.Provider>
            </ShellToolbar.Provider>
          </TitleActions.Provider>
        </AppBarActions.Provider>
      </SectionMotion.Provider>
    </AudioProvider>
  )
}

import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react'
import { ArrowLeft, BellRing, Compass, RefreshCw, Search, Settings } from 'lucide-react'
import { DashboardIcon, FolderIcon } from './components/NavIcons'
import {
  createBrowserRouter,
  createRoutesFromElements,
  Link,
  matchPath,
  Navigate,
  Outlet,
  Route,
  useLocation,
  useMatches,
  useNavigate,
  useNavigationType,
  useRouteError,
} from 'react-router'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AppShell, EmptyState, enterPage, Kbd, TabBar, useMediaQuery } from 'fluid-lycoris'
import { api, type Download } from './api'
import { bugReport } from './bugReport'
import { useAuth, useEvents, useKeyboardUp, useMediaServer } from './hooks'
import Brand from './components/Brand'
import Logo from './components/Logo'
import { useSpeedSampler } from './speedHistory'
import Loading from './components/Loading'
import UpdateToast from './components/UpdateToast'
import Tips from './components/Tips'
import ScrollMemory from './components/ScrollMemory'
import RouteFocus from './components/RouteFocus'
import AppBadgeSync from './components/AppBadgeSync'
import PageScroll from './components/PageScroll'
import CommandPalette from './components/CommandPalette'
import { LiveActivity } from './components/LiveActivity'
import PhoneHint from './components/PhoneHint'
import { TransfersProvider } from './components/TransferSheet'
import { AudioProvider, MiniPlayer } from './components/AudioPlayer'
import { useBack } from './components/playLinks'
import { browserAnimated, RouteTransition, routeMotion, SectionMotion, topPage } from './components/RouteTransition'
import { AccountMenu, AccountSheetButton } from './components/AccountMenu'
import RedirectWithQuery from './components/RedirectWithQuery'
import { AppBarActions, ShellFooter, ShellToolbar, TitleActions, WIDE_MQ } from './components/PageActions'
import { LiveProvider } from './components/liveState'
import { BackLink } from './components/BackLink'
import { SeriesModalProvider, TITLE_PATH, useSeriesModal } from './components/SeriesModal'
import { useRestoreReturn } from './returnTo'
import { FINISHING_KEY } from './pages/setupState'
import Dashboard from './pages/Dashboard'
import { LegacySuggestions } from './components/DiscoverRedirect'
import { DISCOVER_BASE, discoverPath, slugOf } from './discoverRoutes'
import SettingsLayout, { AdminRoute, SettingsHub } from './pages/settings/SettingsLayout'

// Four pages, the same on every device - no "more" sheet: a menu behind a
// button is found half as often as one in sight. The calendar is a view of
// Auto-Sync, the phone's last tab is the search, under the thumb. Settings is
// the gear in the app bar (phone) and the foot of the sidebar (desktop);
// Rename is a tool on a folder, reached from Files.
// motion: how the icon moves once as its page becomes the current one (see
// .t-nav-icon in index.css): the tiles trade places, the arrows turn, the
// needle swings, the folder swings its front open
const TABS = [
  { to: '/', key: 'nav.dashboard', icon: DashboardIcon, motion: 'tiles' },
  { to: '/watches', key: 'nav.watches', icon: RefreshCw, motion: 'turn' },
  { to: DISCOVER_BASE, key: 'nav.suggestions', icon: Compass, motion: 'needle' },
  { to: '/files', key: 'nav.files', icon: FolderIcon, motion: 'flap' },
]
const PHONE_TABS = TABS
// the rules sit beside settings on a desktop: read more often than the rest
const RULES_TO = '/rules'
const SETTINGS = { to: '/settings', key: 'nav.settings', icon: Settings, motion: 'turn' }
const NAV = [...TABS, SETTINGS]
// what the palette can jump to: the nav plus the page of everything that needs the user
const PALETTE_PAGES = [...NAV, { to: '/needs', key: 'needs.title', icon: BellRing }]
// the sync side of the colour code: their entries light up teal, not red
const TEAL = ['/watches', '/files']
// how long a page's entry runs (the last wipe and the widest rise) before
// its mark comes off
const ENTER_MS = 1200
type NavEntry = (typeof NAV)[number]
const onPath = (n: NavEntry, path: string) => path === n.to || (n.to !== '/' && path.startsWith(n.to + '/'))
// screens that belong to a tab without sitting under its path: the history
// and a title card are Heute's, Rename is a tool of Files
const ALSO: Record<string, string[]> = { '/': ['/history', '/needs', '/title/'], '/files': ['/rename'] }
const tabCurrent = (n: NavEntry, path: string) => onPath(n, path) || !!ALSO[n.to]?.some((p) => path.startsWith(p))

// Signed out, or an admin before the first server: whole screens of their own
// that a signed-in session never needs, so they load only when shown. Until
// then the same centred spinner as the session check stands in, which is
// what the screen showed a moment before - nothing moves when they arrive.
const Login = lazy(() => import('./pages/Login'))
const Setup = lazy(() => import('./pages/Setup'))
const AccountUpgrade = lazy(() => import('./pages/AccountUpgrade'))
const loadingScreen = (
  <div className="grid min-h-dvh place-items-center">
    <Loading size="lg" />
  </div>
)

// A screen that failed to load or broke while drawing: an error page inside
// the shell, never a forced reload. Trying again loads or draws the screen
// once more in place, which is all a dropped connection needs. Only a reload
// can fix a bundle of an older build that a deploy removed; then the update
// toast offers it too (armed by the same failure, raised here in case the
// bundler's event did not fire).
const isChunkError = (e: unknown) =>
  /dynamically imported module|module script failed/i.test(e instanceof Error ? e.message : String(e))
function ScreenError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation()
  const chunk = isChunkError(error)
  useEffect(() => {
    if (chunk) window.dispatchEvent(new Event('vite:preloadError'))
  }, [chunk])
  return (
    <EmptyState label={t(chunk ? 'app.screenFailed' : 'app.screenBroke')} className="py-16">
      <span className="block">{t(chunk ? 'app.screenFailedHint' : 'app.screenBrokeHint')}</span>
      {!chunk && (
        <span className="mt-2 block font-mono text-xs break-all">
          {error instanceof Error ? error.message : String(error)}
        </span>
      )}
      <span className="mt-4 flex flex-wrap justify-center gap-2">
        <button type="button" className="t-btn t-btn--primary" onClick={onRetry}>
          {t('app.tryAgain')}
        </button>
        <button type="button" className="t-btn" onClick={() => location.reload()}>
          {t('app.reloadNow')}
        </button>
      </span>
      <ErrorDetails error={error} />
    </EmptyState>
  )
}

// the technical side for a bug report, folded away and stripped of addresses,
// paths and keys before it is shown (bugReport.ts)
function ErrorDetails({ error }: { error: unknown }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const pre = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const report = useMemo(
    () => bugReport(error, { version: qc.getQueryData<{ version?: string }>(['version'])?.version }),
    [error, qc],
  )
  const copy = () =>
    navigator.clipboard.writeText(report).then(
      () => setCopied(true),
      // no clipboard (an insecure origin, a refusal): select it for Ctrl+C
      () => {
        const sel = getSelection()
        if (pre.current && sel) sel.selectAllChildren(pre.current)
      },
    )
  return (
    <details className="ws-err-details">
      <summary>{t('app.details')}</summary>
      <p>{t('app.detailsNote')}</p>
      <pre ref={pre}>{report}</pre>
      <button type="button" className="t-btn" onClick={copy}>
        {copied ? t('app.copied') : t('app.copyReport')}
      </button>
    </details>
  )
}
// a screen that broke while drawing: the same navigation again draws it anew
function RouteError() {
  const navigate = useNavigate()
  const loc = useLocation()
  return (
    <ScreenError
      error={useRouteError()}
      onRetry={() => navigate(loc.pathname + loc.search + loc.hash, { replace: true })}
    />
  )
}

// Root layout element of the data router. A data router (createBrowserRouter)
// is required so form pages can useBlocker() to guard unsaved changes.
function RootLayout() {
  const { data: user, isLoading } = useAuth()
  // an account held for an upgrade reaches nothing but the upgrade itself
  const live = !!user && !user.upgradeRequired
  useEvents(live)
  useRestoreReturn(live)
  useSpeedSampler(live)
  useMediaServer(live)

  if (isLoading) return loadingScreen
  if (!user)
    return (
      <Suspense fallback={loadingScreen}>
        <Login />
      </Suspense>
    )
  if (user.upgradeRequired)
    return (
      <Suspense fallback={loadingScreen}>
        <AccountUpgrade kind={user.upgradeRequired} />
      </Suspense>
    )
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
      <Suspense fallback={loadingScreen}>
        <Setup
          initialStep="import"
          onDone={() => {
            rerender()
            void qc.invalidateQueries({ queryKey: ['settings'] })
          }}
        />
      </Suspense>
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
  /** a layout that draws its own desktop heading with its back link
   *  (settings): the shell's title row stays out */
  ownTitle?: boolean
}
const h = (title: string, back?: string, section?: string): RouteHandle => ({ title, back, section })
const inSettings = (title: string) => h(title, '/settings', 'nav.settings')
// every section of Entdecken is a tab of one page, none stacked on another
const discoverTab = (title: string) => h(title, undefined, 'nav.suggestions')

/**
 * A screen that is not the first one anybody sees, loaded with its route: its
 * code is a chunk of its own, fetched on the way in. The router keeps the
 * screen being left on show until the chunk is in and only then commits the
 * navigation, so there is no fallback to flash or to shift the layout, and
 * the route motion and the page's entry animations run on the real screen.
 * `admin` puts it behind the admin check, as the settings sections that need
 * one are.
 */
// A browser remembers a failed module import by its URL and fails every later
// import of it without asking the server again, so a dropped connection would
// stick until a reload. One more try under a fresh URL fetches it for real;
// the module's own imports keep their URLs and stay shared. The failure names
// the URL in Chromium and Firefox; where it does not, the error stands.
const loadAgain = async <M,>(load: () => Promise<M>): Promise<M> => {
  try {
    return await load()
  } catch (e) {
    const url = String((e as Error)?.message).match(/https?:\/\/\S+?\.js/)?.[0]
    if (!url) throw e
    return import(/* @vite-ignore */ `${url}?retry=${Date.now()}`) as Promise<M>
  }
}
// A screen whose bundle would not load. The router keeps a failed lazy() for
// good, so the route resolves to this stand-in instead: it shows the error
// page, tries the bundle again itself and then draws the real screen, and
// remembers it for every later visit.
const unloaded = <M,>(load: () => Promise<M>, pick: (m: M) => ComponentType, first: unknown): ComponentType => {
  let Loaded: ComponentType | null = null
  return function Unloaded() {
    const [error, setError] = useState(first)
    const [, loaded] = useReducer((n: number) => n + 1, 0)
    if (Loaded) return <Loaded />
    return (
      <ScreenError
        error={error}
        onRetry={() =>
          loadAgain(load).then((m) => {
            Loaded = pick(m)
            loaded()
          }, setError)
        }
      />
    )
  }
}
// /settings/transfers was split: the hardware panel moved to Wiedergabe, the
// rest is Downloads. Old bookmarks and search links keep landing on theirs.
function TransfersRedirect() {
  const { hash } = useLocation()
  return <RedirectWithQuery to={hash === '#hardware' ? '/settings/playback#hardware' : '/settings/downloads'} />
}

const screen =
  <M,>(load: () => Promise<M>, pick: (m: M) => ComponentType, admin = false) =>
  async () => {
    let Page: ComponentType
    try {
      Page = pick(await loadAgain(load))
    } catch (e) {
      Page = unloaded(load, pick, e)
    }
    return {
      Component: admin
        ? () => (
            <AdminRoute>
              <Page />
            </AdminRoute>
          )
        : Page,
    }
  }
const files = () => import('./pages/Files')
const share = () => import('./pages/Share')
const history = () => import('./pages/History')
const needs = () => import('./pages/NeedsPage')
const discover = () => import('./pages/Suggestions')
const assistant = () => import('./pages/Assistant')
const rename = () => import('./pages/Rename')
const trash = () => import('./pages/Trash')
const rules = () => import('./pages/settings/Rules')
const matching = () => import('./pages/settings/Matching')
const data = () => import('./pages/settings/Data')

export const router = createBrowserRouter(
  createRoutesFromElements(
    // a first load straight onto a lazy screen waits for its chunk with the
    // same spinner the session check shows next
    <Route element={<RootLayout />} hydrateFallbackElement={loadingScreen} errorElement={<RouteError />}>
      <Route errorElement={<RouteError />}>
        <Route path="/" element={<Dashboard />} handle={h('nav.dashboard')} />
        {/* a title card's own URL, opened from a link or a reload: the card
          stands over the dashboard (SeriesModalProvider reads the path) */}
        <Route path={TITLE_PATH} element={<Dashboard />} handle={h('nav.dashboard')} />
        {/* the installed app's share target (manifest share_target) */}
        <Route path="/share" lazy={screen(share, (m) => m.default)} handle={h('nav.dashboard')} />
        <Route path="/files" lazy={screen(files, (m) => m.FilesJump)} handle={h('nav.files')} />
        {/* the remote and local browsers merged into /files; their links keep
          the folder they pointed at */}
        <Route path="/remote" element={<RedirectWithQuery to="/files" />} />
        <Route
          path="/local"
          element={<RedirectWithQuery to="/files" rewrite={(p) => (p.set('source', 'local'), p)} />}
        />
        <Route path="/browser" element={<RedirectWithQuery to="/files" />} />
        <Route
          path="/calendar"
          element={<RedirectWithQuery to="/watches" rewrite={(p) => (p.set('view', 'calendar'), p)} />}
        />
        <Route
          path="/history"
          lazy={screen(history, (m) => m.default)}
          handle={h('history.title', '/', 'nav.dashboard')}
        />
        <Route path="/needs" lazy={screen(needs, (m) => m.default)} handle={h('needs.title', '/', 'nav.dashboard')} />
        <Route
          path="/watches"
          lazy={screen(
            () => import('./pages/Watches'),
            (m) => m.default,
          )}
          handle={h('nav.watches')}
        />
        {/* Entdecken: every section a tab of one page, the assistant and the
          ignored items included; the index is the overview */}
        <Route path={DISCOVER_BASE} lazy={screen(discover, (m) => m.default)} handle={h('nav.suggestions')}>
          <Route index lazy={screen(discover, (m) => m.DiscoverHub)} />
          <Route
            path={slugOf('watchlist')}
            lazy={screen(discover, (m) => () => <m.BucketSection bucket="watchlist" />)}
            handle={discoverTab('suggestions.tabWatchlist')}
          />
          <Route
            path={slugOf('recommended')}
            lazy={screen(discover, (m) => () => <m.BucketSection bucket="recommended" />)}
            handle={discoverTab('suggestions.tabRecommended')}
          />
          <Route
            path={slugOf('trending')}
            lazy={screen(discover, (m) => () => <m.BucketSection bucket="trending" />)}
            handle={discoverTab('suggestions.tabTrending')}
          />
          <Route
            path={slugOf('upgrades')}
            lazy={screen(discover, (m) => m.UpgradesSection)}
            handle={discoverTab('suggestions.tabUpgrades')}
          />
          <Route
            path={slugOf('incomplete')}
            lazy={screen(discover, (m) => () => <m.BucketSection bucket="incomplete" />)}
            handle={discoverTab('suggestions.tabIncomplete')}
          />
          <Route
            path={slugOf('duplicates')}
            lazy={screen(discover, (m) => m.DuplicatesSection)}
            handle={discoverTab('suggestions.tabDuplicates')}
          />
          <Route
            path={slugOf('ignored')}
            lazy={screen(discover, (m) => m.IgnoredSection)}
            handle={discoverTab('suggestions.ignored')}
          />
          <Route
            path={slugOf('assistant')}
            lazy={screen(assistant, (m) => m.default)}
            handle={discoverTab('nav.assistant')}
          />
          <Route path="*" element={<Navigate to={DISCOVER_BASE} replace />} />
        </Route>
        {/* the old addresses of the same screens */}
        <Route path="/suggestions/*" element={<LegacySuggestions />} />
        <Route path="/assistant" element={<Navigate to={discoverPath('assistant')} replace />} />
        <Route path="/plex" element={<Navigate to={DISCOVER_BASE} replace />} />
        <Route path="/servers" element={<Navigate to="/settings/servers" replace />} />
        <Route path="/rename" lazy={screen(rename, (m) => m.default)} handle={h('nav.rename', '/files', 'nav.files')} />
        <Route
          path="/files/trash"
          lazy={screen(trash, (m) => m.default)}
          handle={h('trash.title', '/files', 'nav.files')}
        />
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
          path={RULES_TO}
          lazy={screen(rules, (m) => m.default)}
          handle={{ title: 'settings.nav.rules', back: '/settings', backHistory: true }}
        />
        <Route path="/settings" element={<SettingsLayout />} handle={{ ...h('nav.settings'), ownTitle: true }}>
          <Route index element={<SettingsHub />} />
          <Route
            path="general"
            lazy={screen(
              () => import('./pages/settings/General'),
              (m) => m.default,
            )}
            handle={inSettings('settings.nav.general')}
          />
          <Route path="look" element={<Navigate to="/settings/general" replace />} />
          <Route
            path="about"
            lazy={screen(
              () => import('./pages/settings/About'),
              (m) => m.default,
            )}
            handle={inSettings('settings.nav.about')}
          />
          <Route
            path="account"
            lazy={screen(
              () => import('./pages/settings/Account'),
              (m) => m.default,
            )}
            handle={inSettings('settings.nav.account')}
          />
          <Route
            path="sync"
            lazy={screen(
              () => import('./pages/settings/SyncDefaults'),
              (m) => m.default,
            )}
            handle={inSettings('settings.nav.sync')}
          />
          <Route path="rules" element={<RedirectWithQuery to="/rules" />} />
          <Route
            path="notifications"
            lazy={screen(
              () => import('./pages/settings/Notifications'),
              (m) => m.default,
            )}
            handle={inSettings('settings.nav.notifications')}
          />
          <Route
            path="servers"
            lazy={screen(
              () => import('./pages/settings/Servers'),
              (m) => m.default,
            )}
            handle={inSettings('nav.servers')}
          />
          <Route
            path="servers/new"
            lazy={screen(
              () => import('./pages/settings/Servers'),
              (m) => m.ServerFormPage,
            )}
            handle={h('servers.newTitle', '/settings/servers', 'nav.settings')}
          />
          <Route
            path="servers/:id"
            lazy={screen(
              () => import('./pages/settings/Servers'),
              (m) => m.ServerFormPage,
            )}
            handle={h('servers.editTitle', '/settings/servers', 'nav.settings')}
          />
          <Route path="transfers" element={<TransfersRedirect />} />
          <Route
            path="downloads"
            lazy={screen(
              () => import('./pages/settings/Downloads'),
              (m) => m.default,
              true,
            )}
            handle={inSettings('settings.nav.downloads')}
          />
          <Route
            path="playback"
            lazy={screen(
              () => import('./pages/settings/Playback'),
              (m) => m.default,
              true,
            )}
            handle={inSettings('settings.nav.playback')}
          />
          <Route
            path="security"
            lazy={screen(
              () => import('./pages/settings/Security'),
              (m) => m.default,
              true,
            )}
            handle={inSettings('settings.nav.security')}
          />
          <Route
            path="integrations"
            lazy={screen(
              () => import('./pages/settings/Integrations'),
              (m) => m.default,
              true,
            )}
            handle={inSettings('settings.nav.integrations')}
          />
          <Route
            path="jobs"
            lazy={screen(
              () => import('./pages/settings/Jobs'),
              (m) => m.default,
              true,
            )}
            handle={inSettings('settings.nav.jobs')}
          />
          <Route
            path="matching"
            lazy={screen(matching, (m) => m.default, true)}
            handle={inSettings('settings.nav.matching')}
          />
          <Route
            path="matching/:server/:source"
            lazy={screen(matching, (m) => m.MatchesPage, true)}
            handle={h('settings.nav.matching', '/settings/matching', 'nav.settings')}
          />
          <Route path="data" lazy={screen(data, (m) => m.default, true)} handle={inSettings('settings.nav.data')} />
          <Route
            path="data/:store"
            lazy={screen(data, (m) => m.StorePage, true)}
            handle={h('settings.nav.data', '/settings/data', 'nav.settings')}
          />
          {/* merged sections: the old paths land on their panel */}
          <Route path="email" element={<Navigate to="/settings/integrations#email" replace />} />
          <Route path="users" element={<Navigate to="/settings/security#users" replace />} />
          <Route path="import" element={<Navigate to="/settings/data#import" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
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
  // the desktop title row: every screen's h1, with the way back on a stacked
  // one; not over a full-screen view and not where a layout draws its own
  const matches = useMatches()
  const ownTitle = matches.some((m) => (m.handle as RouteHandle | undefined)?.ownTitle)
  const titleRow = wide && !fullScreen && !ownTitle
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
  const screenTitle = title ? t(title) : 'WeebSync'

  // Heute lists the transfers itself; its series page keeps the pathname of
  // the page it was opened on, only a link straight to one stands on Heute
  const onToday = location.pathname === '/' || !!matchPath(TITLE_PATH, location.pathname)

  const sidebar = (
    <aside className="ws-side" aria-label={t('nav.side')}>
      <div className="ws-brand">
        {/* the mark is the way home from anywhere, as on every site */}
        <Link to="/" className="rounded-xs">
          {/* folds into the mark and back out on every page change, where
              the sidebar shows (it is display:none below the wide layout) */}
          <Brand
            variant="rail"
            slogan={t('app.tagline')}
            replayKey={wide ? location.pathname : undefined}
            className="mt-3 mb-2"
          />
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
          <Link
            key={n.to}
            to={n.to}
            aria-current={tabCurrent(n, location.pathname) ? 'page' : undefined}
            className="ws-side-link"
            data-tone={tone(n)}
          >
            {icon(n)}
            {t(n.key)}
          </Link>
        ))}
      </nav>
      {/* settings at the foot, apart from the pages: visited rarely, but
          always in the same place; above them what transfers right now */}
      <div className="ws-side-foot">
        <MiniPlayer variant="rail" />
        {!onToday && <LiveActivity variant="rail" />}
        <PhoneHint />
        {/* settings, the account and the way out in one menu; a newer build
            out puts a dot on the button and on the About entry */}
        <AccountMenu email={email} />
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
      {/* the gear on every top-level page, opening the account menu as a
          sheet; a stacked screen has its back link instead, and Settings
          itself needs no way into itself */}
      {!back && !onPath(SETTINGS, location.pathname) && <AccountSheetButton email={email} />}
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
            <Link
              key={n.to}
              to={n.to}
              aria-current={tabCurrent(n, location.pathname) ? 'page' : undefined}
              className="ws-tab"
              data-tone={tone(n)}
            >
              <span aria-hidden className="ws-pip" />
              {icon(n)}
              <span>{t(n.key)}</span>
            </Link>
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
                            <RouteFocus title={screenTitle} />
                            <RouteTitle />
                            <AppBadgeSync />
                            <ScrollMemory />
                            <CommandPalette pages={PALETTE_PAGES} open={palette} onOpenChange={setPalette} />
                          </>
                        }
                      >
                        {/* the desktop's title row: the screen's h1 over the
                      content, with a back link on a stacked screen. Only
                      rendered wide: on a phone the pull to refresh moves the
                      first thing in <main> */}
                        {titleRow && (
                          <header className="ws-title">
                            {back && <BackLink to={back} className="-ml-2" />}
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
                        {/* what transfers right now, riding the bottom edge of Today: on
                      the other pages it covered their own controls */}
                        {!wide && !immersive && location.pathname === '/' && (
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

import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, Link, Outlet, RouterProvider, useNavigate } from 'react-router'
import RouteFocus from '../components/RouteFocus'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (k: string) => k }) as never,
}))

// the shell's skeleton: the skip link first, then a <main> with the page's heading
function Shell() {
  const navigate = useNavigate()
  return (
    <div className="app-shell">
      <RouteFocus title="Title" />
      <nav>
        <Link to="/b">to b</Link>
        <button onClick={() => navigate('/b', { replace: true })}>replace b</button>
        <button onClick={() => navigate(-1)}>back</button>
        <Link to="/a?x=1">same page</Link>
      </nav>
      <main>
        <Outlet />
      </main>
    </div>
  )
}
const routes = [
  {
    element: <Shell />,
    children: [
      { path: '/a', element: <h1>A</h1> },
      { path: '/b', element: <h1>B</h1> },
      {
        path: '/c',
        element: (
          <>
            <h1>C</h1>
            <button>inside</button>
          </>
        ),
      },
      { path: '/field', element: <input aria-label="field" autoFocus /> },
    ],
  },
]
const frames = async () => {
  // two animation frames, as the component waits
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60))
  })
}

afterEach(() => vi.restoreAllMocks())

describe('RouteFocus', () => {
  it('puts the skip link first and sends focus to <main>', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/a'] })
    const { container } = render(<RouterProvider router={router} />)
    const first = container.querySelector('a, button, input') as HTMLElement
    expect(first).toHaveTextContent('app.skipToContent')
    first.click()
    const main = container.querySelector('main') as HTMLElement
    expect(main).toHaveAttribute('tabindex', '-1')
    expect(document.activeElement).toBe(main)
  })

  it('moves focus to the new page heading after a push, and announces the title', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/a'] })
    render(<RouterProvider router={router} />)
    // no focus theft on the first load
    expect(document.activeElement).toBe(document.body)
    screen.getByText('to b').focus()
    await act(async () => screen.getByText('to b').click())
    await frames()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'B' }))
    expect(screen.getByRole('status')).toHaveTextContent('Title')
  })

  it('does the same after a replace', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/a'] })
    render(<RouterProvider router={router} />)
    await act(async () => screen.getByText('replace b').click())
    await frames()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'B' }))
  })

  it('leaves focus alone on back and forward', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/a', '/b'], initialIndex: 1 })
    render(<RouterProvider router={router} />)
    const back = screen.getByText('back')
    back.focus()
    await act(async () => back.click())
    await frames()
    expect(screen.getByRole('heading', { name: 'A' })).toBeInTheDocument()
    expect(document.activeElement).toBe(back)
  })

  it('moves focus to the heading on back when the focused element is gone', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/a', '/c'], initialIndex: 1 })
    render(<RouterProvider router={router} />)
    screen.getByText('inside').focus()
    await act(async () => {
      await router.navigate(-1)
    })
    await frames()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'A' }))
  })

  it('does nothing for a change of the query only', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/a'] })
    render(<RouterProvider router={router} />)
    const link = screen.getByText('same page')
    link.focus()
    await act(async () => link.click())
    await frames()
    expect(document.activeElement).toBe(link)
  })

  it('does not take focus from a field the new page focused on purpose', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/a'] })
    render(<RouterProvider router={router} />)
    await act(async () => {
      await router.navigate('/field')
    })
    await frames()
    expect(document.activeElement).toBe(screen.getByLabelText('field'))
  })
})

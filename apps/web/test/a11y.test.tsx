import axe from 'axe-core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '@/widgets/app-shell/ui/app-shell';
import { LoginPage } from '@/pages/login';
import { QueuePage } from '@/pages/queue';
import { useAnnounce } from '@/shared/ui/announcer';
import { SkipLink } from '@/shared/ui/skip-link';
import {
  API,
  CUSTOMER,
  ME,
  envelope,
  http,
  HttpResponse,
  renderApp,
  router,
  server,
} from './utils';

const route = { path: '/queue' }; // the page the mocked router reports
vi.mock('next/navigation', async () => {
  const utils = await import('./utils');
  return {
    useRouter: () => utils.router,
    usePathname: () => route.path,
    useSearchParams: () => new URLSearchParams(),
  };
});
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** axe-core in jsdom: structure, names, roles, ARIA, labels. (Colour contrast needs a real browser: the Playwright e2e covers it.) */
/** What the queue page (inside the shell) asks the api for. */
const queueApi = () => [
  http.get(`${API}/notifications`, () => HttpResponse.json({ items: [], unreadCount: 0 })),
  http.get(`${API}/tickets`, () => HttpResponse.json({ items: [], nextCursor: null })),
  http.get(`${API}/saved-views`, () => HttpResponse.json([])),
];

const audit = async (container: Element) => {
  const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  return results.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(' | ')})`,
  );
};

describe.each([['uk' as const], ['en' as const]])('accessibility (%s)', (locale) => {
  it('the login page has no axe violations — pristine, with validation errors showing, and with a server error', async () => {
    const { container } = renderApp(<LoginPage />, { locale });
    server.use(http.get(`${API}/me`, () => envelope(401, 'unauthenticated')));
    expect(await audit(container)).toEqual([]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Увійти|Sign in/ }));
    await waitFor(() =>
      expect(container.querySelectorAll('[aria-invalid="true"]')).toHaveLength(2),
    );
    expect(await audit(container)).toEqual([]);

    server.use(http.post(`${API}/auth/login`, () => envelope(401, 'unauthenticated')));
    await user.type(screen.getByLabelText(/пошта|Email/i), 'a@b.co');
    await user.type(screen.getByLabelText(/Пароль|Password/i), 'x');
    await user.click(screen.getByRole('button', { name: /Увійти|Sign in/ }));
    await screen.findByTestId('login-error');
    expect(await audit(container)).toEqual([]);
  });

  it('the signed-in shell (landmarks, nav, header controls, main) has no violations for every role', async () => {
    for (const user of [ME, CUSTOMER, { ...ME, role: 'lead' as const }]) {
      route.path = user.role === 'customer' ? '/tickets' : '/queue'; // each role on a page it may open
      server.use(
        http.get(`${API}/me`, () => HttpResponse.json(user)),
        ...queueApi(),
      );
      const { container, unmount } = renderApp(
        <AppShell>
          <QueuePage />
        </AppShell>,
        { locale },
      );
      await screen.findByRole('main');
      for (const nav of screen.getAllByRole('navigation')) expect(nav).toHaveAccessibleName(); // several landmarks of one kind must be distinguishable
      for (const box of screen.getAllByRole('combobox')) expect(box).toHaveAccessibleName(); // every select is named (label or aria-label)
      expect(await audit(container), user.role).toEqual([]);
      unmount();
    }
  });

  it('a customer who opens a staff URL (/queue) is sent to their own page and never sees staff controls; the other way round too', async () => {
    for (const [user, path, home] of [
      [CUSTOMER, '/queue', '/tickets'],
      [CUSTOMER, '/settings', '/tickets'],
      [ME, '/settings', '/queue'],
      [ME, '/tickets', '/queue'],
    ] as const) {
      route.path = path;
      router.replace.mockClear();
      server.use(
        http.get(`${API}/me`, () => HttpResponse.json(user)),
        ...queueApi(),
      );
      const { unmount } = renderApp(
        <AppShell>
          <p>PAGE CONTENT</p>
        </AppShell>,
        { locale },
      );
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith(home));
      expect(screen.queryByText('PAGE CONTENT')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /take next|взяти наступну/i }),
      ).not.toBeInTheDocument();
      unmount();
    }
    route.path = '/queue';
  });

  it('exactly one <h1> per page and the main landmark is the skip-link target', async () => {
    server.use(
      http.get(`${API}/me`, () => HttpResponse.json(ME)),
      ...queueApi(),
    );
    renderApp(
      <AppShell>
        <QueuePage />
      </AppShell>,
      { locale },
    );
    const main = await screen.findByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('link', { current: 'page' })).toBeInTheDocument(); // "you are here" in the navigation
  });
});

describe('keyboard and screen-reader support', () => {
  it('the skip link is the first tab stop and points at #main', async () => {
    const user = userEvent.setup();
    renderApp(
      <>
        <SkipLink label="Skip" />
        <main id="main" tabIndex={-1}>
          <button>first</button>
        </main>
      </>,
    );
    await user.tab();
    const link = screen.getByRole('link', { name: 'Skip' });
    expect(link).toHaveFocus();
    expect(link).toHaveAttribute('href', '#main');
  });

  it('the whole header is reachable by Tab in a sensible order and Sign out works from the keyboard', async () => {
    server.use(
      http.get(`${API}/me`, () => HttpResponse.json(ME)),
      http.post(`${API}/auth/logout`, () => new HttpResponse(null, { status: 204 })),
    );
    const user = userEvent.setup();
    renderApp(
      <AppShell>
        <QueuePage />
      </AppShell>,
      { locale: 'en' },
    );
    await screen.findByRole('main');
    const order: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      await user.tab();
      order.push(
        document.activeElement?.getAttribute('aria-label') ??
          document.activeElement?.textContent?.trim() ??
          '',
      );
    }
    expect(order).toEqual([
      'Queue',
      expect.stringContaining('Notifications'),
      'Language',
      'Theme',
      'Sign out',
    ]); // navigation, then the header controls, in reading order
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login'));
  });

  it('announcements go to a live region; repeating the same text is announced again', async () => {
    const Button = () => {
      const announce = useAnnounce();
      return <button onClick={() => announce('New message in HD-1')}>go</button>;
    };
    const user = userEvent.setup();
    renderApp(<Button />); // renderApp already provides the announcer
    const polite = screen.getByTestId('live-polite');
    expect(polite).toHaveAttribute('aria-live', 'polite');
    await user.click(screen.getByText('go'));
    await waitFor(() => expect(polite).toHaveTextContent('New message in HD-1'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await user.click(screen.getByText('go'));
    expect(polite).toHaveTextContent(''); // cleared first, so the second identical message re-triggers the announcement
    await waitFor(() => expect(polite).toHaveTextContent('New message in HD-1'));
  });

  it('assertive announcements use role=alert', async () => {
    const Button = () => {
      const announce = useAnnounce();
      return <button onClick={() => announce('Connection lost', 'assertive')}>go</button>;
    };
    const user = userEvent.setup();
    renderApp(<Button />); // renderApp already provides the announcer
    await user.click(screen.getByText('go'));
    const assertive = screen.getByTestId('live-assertive');
    expect(assertive).toHaveAttribute('role', 'alert');
    await waitFor(() => expect(assertive).toHaveTextContent('Connection lost'));
  });
});

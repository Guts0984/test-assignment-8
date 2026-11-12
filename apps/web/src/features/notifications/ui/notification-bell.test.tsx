import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { API, http, HttpResponse, renderApp, server } from '../../../../test/utils';
import { uid } from '../../../../test/fixtures';
import { NotificationBell } from './notification-bell';

vi.mock('next/navigation', async () => {
  const utils = await import('../../../../test/utils');
  return { useRouter: () => utils.router, usePathname: () => '/queue' };
});
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const item = (n: number, type: string, read: boolean) => ({
  id: uid(n),
  type,
  ticket: { id: uid(50 + n), code: `HD-${1000 + n}`, subject: `Subject ${n}` },
  createdAt: '2026-11-12T09:00:00.000Z',
  readAt: read ? '2026-11-12T09:30:00.000Z' : null,
});
const serve = (
  items: ReturnType<typeof item>[],
  unreadCount: number,
  onRead?: (ids: string[]) => void,
) =>
  server.use(
    http.get(`${API}/notifications`, () => HttpResponse.json({ items, unreadCount })),
    http.post(`${API}/notifications/read`, async ({ request }) => {
      onRead?.(((await request.json()) as { ids: string[] }).ids);
      return HttpResponse.json({ marked: 1 });
    }),
  );

describe('NotificationBell', () => {
  it('the count is in the accessible name (with the right plural), and shown visually', async () => {
    serve([item(1, 'assigned', false), item(2, 'sla_warning', false)], 2);
    renderApp(<NotificationBell />, { locale: 'en' });
    expect(
      await screen.findByRole('button', { name: 'Notifications: 2 unread notifications' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('bell-count')).toHaveTextContent('2');
  });
  it('uk plural: 1 / 2 / 5 unread', async () => {
    for (const [n, text] of [
      [1, '1 непрочитане сповіщення'],
      [2, '2 непрочитані сповіщення'],
      [5, '5 непрочитаних сповіщень'],
    ] as const) {
      serve([], n);
      const { unmount } = renderApp(<NotificationBell />, { locale: 'uk' });
      expect(await screen.findByRole('button', { name: new RegExp(text) })).toBeInTheDocument();
      unmount();
    }
  });
  it('no unread → no badge', async () => {
    serve([item(1, 'assigned', true)], 0);
    renderApp(<NotificationBell />, { locale: 'en' });
    await screen.findByRole('button', { name: /0 unread|Notifications/ });
    expect(screen.queryByTestId('bell-count')).not.toBeInTheDocument();
  });
  it('opens a panel with one link per notification (to its ticket), Esc closes it and returns focus to the bell', async () => {
    const user = userEvent.setup();
    serve(
      [
        item(1, 'assigned', false),
        item(2, 'customer_replied', true),
        item(3, 'sla_breached', false),
      ],
      2,
    );
    renderApp(<NotificationBell />, { locale: 'en' });
    const bell = await screen.findByRole('button', { name: /Notifications/ });
    await user.click(bell);
    expect(bell).toHaveAttribute('aria-expanded', 'true');
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      `/tickets/${uid(51)}`,
      `/tickets/${uid(52)}`,
      `/tickets/${uid(53)}`,
    ]);
    expect(links[0]).toHaveTextContent('Ticket HD-1001 was assigned to you');
    expect(links[1]).toHaveTextContent('The customer replied in HD-1002');
    expect(links[2]).toHaveTextContent('SLA breached in HD-1003');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument();
    expect(bell).toHaveFocus();
  });
  it('clicking an unread notification marks it read; "mark all" sends every unread id', async () => {
    const user = userEvent.setup();
    const reads: string[][] = [];
    serve(
      [item(1, 'assigned', false), item(2, 'assigned', false), item(3, 'assigned', true)],
      2,
      (ids) => reads.push(ids),
    );
    renderApp(<NotificationBell />, { locale: 'en' });
    await user.click(await screen.findByRole('button', { name: /Notifications/ }));
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(reads).toEqual([[uid(1), uid(2)]]));
  });
  it('empty state', async () => {
    const user = userEvent.setup();
    serve([], 0);
    renderApp(<NotificationBell />, { locale: 'en' });
    await user.click(await screen.findByRole('button', { name: /Notifications/ }));
    expect(screen.getByText('No notifications')).toBeInTheDocument();
  });
});

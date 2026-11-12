import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TicketDto } from '@helpdesk/shared';
import { API, envelope, http, HttpResponse, renderApp, server } from '../../../../test/utils';
import { ticket, uid } from '../../../../test/fixtures';
import { diffForm, parseTags, planPatch, remoteChanges, toForm } from '../model/sidebar-model';
import { TicketSidebar } from './ticket-sidebar';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('sidebar model (pure)', () => {
  const base = ticket(1, { tags: ['vip'] });
  it('a form built from a ticket has no changes', () =>
    expect(diffForm(base, toForm(base))).toEqual([]));
  it('planPatch contains only what changed, at the base version; nothing changed → null', () => {
    expect(planPatch(base, toForm(base))).toBeNull();
    expect(planPatch(base, { ...toForm(base), priority: 'high', tags: 'vip, refund' })).toEqual({
      version: 1,
      priority: 'high',
      tags: ['vip', 'refund'],
    });
    expect(planPatch(base, { ...toForm(base), assigneeId: null })).toBeNull();
    expect(planPatch(base, { ...toForm(base), assigneeId: uid(7) })).toEqual({
      version: 1,
      assigneeId: uid(7),
    });
  });
  it('tags are normalised and reordering / case / duplicates are not a change', () => {
    expect(parseTags(' VIP , Refund,vip,, x'.concat(',', 'y'.repeat(41)))).toEqual([
      'vip',
      'refund',
      'x',
    ]);
    expect(diffForm(base, { ...toForm(base), tags: 'VIP, vip' })).toEqual([]);
  });
  it("rebaseForm: my edits stay, untouched fields adopt the other person's change (nothing is silently overwritten)", async () => {
    const { rebaseForm } = await import('../model/sidebar-model');
    const mine = { ...toForm(base), status: 'pending' as const };
    const current = ticket(1, { version: 3, priority: 'urgent', tags: ['vip', 'refund'] });
    expect(rebaseForm(base, mine, current)).toEqual({
      status: 'pending',
      priority: 'urgent',
      category: 'payment',
      assigneeId: null,
      tags: 'vip, refund',
    });
    expect(planPatch(current, rebaseForm(base, mine, current))).toEqual({
      version: 3,
      status: 'pending',
    });
  });
  it('remoteChanges lists what somebody else changed between two versions', () => {
    const current = ticket(1, { version: 4, status: 'pending', priority: 'urgent', tags: ['vip'] });
    expect(remoteChanges(base, current).sort()).toEqual(['priority', 'status']);
  });
  it('rebasing: my edit that equals the current value stops being a change; the others remain', () => {
    const mine = { ...toForm(base), status: 'pending' as const, priority: 'high' as const };
    const current = ticket(1, { version: 5, status: 'pending', tags: ['vip'] });
    expect(planPatch(current, mine)).toEqual({ version: 5, priority: 'high' });
  });
});

describe('TicketSidebar: version conflicts keep what the user typed (acceptance #7)', () => {
  const agents = [{ id: uid(10), name: 'Іван', categories: ['payment' as const] }];
  const show = (t: TicketDto) =>
    renderApp(<TicketSidebar ticket={t} role="lead" meId={uid(10)} agents={agents} />, {
      locale: 'en',
    });

  it('a 409 shows what changed, leaves the form untouched and does not lose the typed tags', async () => {
    const user = userEvent.setup();
    const current = ticket(1, { version: 3, priority: 'urgent', tags: ['vip'] });
    server.use(
      http.patch(`${API}/tickets/${uid(1)}`, () =>
        envelope(409, 'version_conflict', 'changed', { current }),
      ),
    );
    show(ticket(1, { tags: ['vip'] }));
    await user.selectOptions(screen.getByLabelText('Status'), 'pending');
    await user.clear(screen.getByLabelText('Tags'));
    await user.type(screen.getByLabelText('Tags'), 'vip, my-new-tag');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const box = await screen.findByTestId('conflict');
    expect(box).toHaveAttribute('role', 'alert');
    expect(box).toHaveTextContent('Someone else has changed this ticket');
    expect(within(box).getByText(/Priority/)).toBeInTheDocument(); // what the other person changed
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('pending'); // my edits are still there
    expect((screen.getByLabelText('Tags') as HTMLInputElement).value).toBe('vip, my-new-tag');
  });

  it('"keep my edits on top" re-bases on the current version: the next save is sent at THAT version and only with my own changes', async () => {
    const user = userEvent.setup();
    const bodies: Array<Record<string, unknown>> = [];
    const current = ticket(1, { version: 3, priority: 'urgent' });
    server.use(
      http.patch(`${API}/tickets/${uid(1)}`, async ({ request }) => {
        const b = (await request.json()) as Record<string, unknown>;
        bodies.push(b);
        return bodies.length === 1
          ? envelope(409, 'version_conflict', 'changed', { current })
          : HttpResponse.json({ ...current, version: 4, status: 'pending' });
      }),
      http.get(`${API}/tickets/${uid(1)}`, () =>
        HttpResponse.json({ ticket: current, messages: [], events: [], rating: null }),
      ),
    );
    show(ticket(1));
    await user.selectOptions(screen.getByLabelText('Status'), 'pending');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByTestId('conflict');
    await user.click(
      screen.getByRole('button', { name: 'Keep my edits on top of the current version' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[0]).toEqual({ version: 1, status: 'pending' });
    expect(bodies[1]).toEqual({ version: 3, status: 'pending' }); // my status only; the other person's priority is not overwritten
    await waitFor(() => expect(screen.queryByTestId('conflict')).not.toBeInTheDocument());
  });

  it('"show current values" discards my edits and adopts the server state', async () => {
    const user = userEvent.setup();
    const current = ticket(1, { version: 3, priority: 'urgent' });
    server.use(
      http.patch(`${API}/tickets/${uid(1)}`, () =>
        envelope(409, 'version_conflict', 'changed', { current }),
      ),
    );
    show(ticket(1));
    await user.selectOptions(screen.getByLabelText('Status'), 'pending');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByTestId('conflict');
    await user.click(screen.getByRole('button', { name: 'Show current values' }));
    expect((screen.getByLabelText('Priority') as HTMLSelectElement).value).toBe('urgent');
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('open');
    expect(screen.queryByTestId('conflict')).not.toBeInTheDocument();
  });

  it('a LIVE update while the form is untouched is followed silently; while the user is editing it only warns', async () => {
    const user = userEvent.setup();
    const { rerender } = show(ticket(1));
    const wrap = (t: TicketDto) => (
      <TicketSidebar ticket={t} role="lead" meId={uid(10)} agents={agents} />
    );
    rerender(wrap(ticket(1, { version: 2, priority: 'high' })));
    await waitFor(() =>
      expect((screen.getByLabelText('Priority') as HTMLSelectElement).value).toBe('high'),
    );
    expect(screen.queryByTestId('conflict')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Status'), 'pending');
    rerender(wrap(ticket(1, { version: 3, priority: 'urgent' })));
    expect(await screen.findByTestId('conflict')).toBeInTheDocument();
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('pending');
    expect((screen.getByLabelText('Priority') as HTMLSelectElement).value).toBe('high'); // not yanked from under the user
  });

  it('role rules: an agent cannot edit the category and only sees themselves in the assignee list; closed tickets are read-only', () => {
    renderApp(
      <TicketSidebar
        ticket={ticket(1)}
        role="agent"
        meId={uid(10)}
        agents={[...agents, { id: uid(11), name: 'Zoya', categories: [] }]}
      />,
      { locale: 'en' },
    );
    expect(screen.getByLabelText('Category')).toBeDisabled();
    expect(screen.getByText('Only a lead changes the category')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Zoya' })).not.toBeInTheDocument();
    document.body.innerHTML = '';
    renderApp(
      <TicketSidebar
        ticket={ticket(2, { status: 'closed' })}
        role="lead"
        meId={uid(10)}
        agents={agents}
      />,
      { locale: 'en' },
    );
    for (const label of ['Status', 'Priority', 'Category', 'Assignee', 'Tags'])
      expect(screen.getByLabelText(label)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('only legal status transitions are offered (resolved cannot go back to pending)', () => {
    show(ticket(1, { status: 'resolved' }));
    const options = within(screen.getByLabelText('Status'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Resolved', 'Open', 'Closed']);
  });

  it('SLA block: shows both deadlines, a paused clock and a breach', () => {
    show(
      ticket(1, { sla: { ...ticket(1).sla!, pausedAt: '2026-11-12T10:00:00Z', breached: true } }),
    );
    expect(screen.getByText(/SLA clock paused/)).toBeInTheDocument();
    expect(screen.getByText('SLA breached')).toBeInTheDocument();
    expect(screen.getByText(/First response due/)).toBeInTheDocument();
    expect(screen.getByText(/Resolution due/)).toBeInTheDocument();
  });
});

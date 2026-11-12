import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  API,
  MESSAGES,
  envelope,
  http,
  HttpResponse,
  renderApp,
  server,
} from '../../../../test/utils';
import { ReplyComposer } from './reply-composer';

vi.mock('next/navigation', async () => {
  const utils = await import('../../../../test/utils');
  return {
    useRouter: () => utils.router,
    usePathname: () => '/tickets/1',
    useSearchParams: () => new URLSearchParams(),
  };
});

const ME = '11111111-1111-4111-8111-111111111111';
const TID = '33333333-3333-4333-8333-333333333333';
const TEMPLATES = [
  {
    id: '44444444-4444-4444-8444-444444444444',
    title: 'Hello',
    body: 'Hi {{customer_name}}, about {{ticket_number}}',
    category: null,
    updatedAt: '2026-01-01T00:00:00Z',
  },
];
const ticketBody = {
  ticket: { id: TID, code: 'HD-1042', status: 'open', customer: { name: 'Олена' } },
};

let sent: Array<Record<string, unknown>> = [];
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  sent = [];
  window.localStorage.clear();
  server.use(
    http.get(`${API}/canned-responses`, () => HttpResponse.json(TEMPLATES)),
    http.post(`${API}/tickets/${TID}/typing`, () => new HttpResponse(null, { status: 204 })),
    http.post(`${API}/tickets/${TID}/messages`, async ({ request }) => {
      sent.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(
        { message: {}, ticket: ticketBody.ticket, replayed: false, spawnedFrom: null },
        { status: 201 },
      );
    }),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const staff = () =>
  renderApp(
    <ReplyComposer
      ticketId={TID}
      ticketCode="HD-1042"
      customerName="Олена"
      meId={ME}
      role="agent"
    />,
    { locale: 'en' },
  );
const m = MESSAGES.en.staff.composer;
const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;

describe('ReplyComposer (staff)', () => {
  it('starts in REPLY mode and says plainly that the customer will see it', async () => {
    staff();
    expect(screen.getByRole('radio', { name: m.modeReply })).toBeChecked();
    expect(screen.getByTestId('visibility-hint')).toHaveTextContent(m.replyHint);
    expect(screen.getByRole('button', { name: MESSAGES.en.ticket.reply.send })).toBeInTheDocument();
  });

  it('note mode: different label, different hint, no "send and wait/resolve", and the message is sent as INTERNAL', async () => {
    const user = userEvent.setup();
    staff();
    await user.click(screen.getByRole('radio', { name: m.modeNote }));
    expect(screen.getByTestId('visibility-hint')).toHaveTextContent(m.noteHint);
    expect(document.querySelector('form')).toHaveAttribute('data-mode', 'note');
    expect(screen.queryByRole('button', { name: m.sendAndWait })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: m.sendAndResolve })).not.toBeInTheDocument();
    await user.type(box(), 'secret thought');
    await user.click(screen.getByRole('button', { name: m.sendNote }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ kind: 'internal', body: 'secret thought' });
    expect(sent[0]).not.toHaveProperty('setStatus');
  });

  it('switching a half-written NOTE to reply shows a warning that the customer will now see it', async () => {
    const user = userEvent.setup();
    staff();
    await user.click(screen.getByRole('radio', { name: m.modeNote }));
    await user.type(box(), 'private words');
    expect(screen.queryByText(m.confirmNoteToReply)).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: m.modeReply }));
    expect(screen.getByRole('status', { name: '' })).toBeDefined();
    expect(screen.getByText(m.confirmNoteToReply)).toBeInTheDocument();
  });

  it('"send and wait" and "send and resolve" are public replies that carry the status', async () => {
    const user = userEvent.setup();
    staff();
    await user.type(box(), 'please send a screenshot');
    await user.click(screen.getByRole('button', { name: m.sendAndWait }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ kind: 'public', setStatus: 'pending' });
    await user.type(box(), 'all fixed');
    await user.click(screen.getByRole('button', { name: m.sendAndResolve }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ kind: 'public', setStatus: 'resolved' });
  });

  it('Ctrl+Enter and Cmd+Enter send; plain Enter adds a line', async () => {
    const user = userEvent.setup();
    staff();
    await user.type(box(), 'line one{Enter}line two');
    expect(sent).toHaveLength(0);
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toBe('line one\nline two');
    await user.type(box(), 'second');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(sent).toHaveLength(2));
  });

  it('an empty or blank message cannot be sent (button disabled, shortcut ignored)', async () => {
    const user = userEvent.setup();
    staff();
    expect(screen.getByRole('button', { name: MESSAGES.en.ticket.reply.send })).toBeDisabled();
    await user.type(box(), '   ');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(sent).toHaveLength(0);
  });

  it('a template is inserted with the customer name and ticket number filled in', async () => {
    const user = userEvent.setup();
    staff();
    const select = await screen.findByRole('combobox', { name: m.templates });
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, 'Hello');
    expect(box().value).toBe('Hi Олена, about HD-1042');
  });

  it('a hostile customer name cannot inject template text', async () => {
    const user = userEvent.setup();
    renderApp(
      <ReplyComposer
        ticketId={TID}
        ticketCode="HD-1042"
        customerName="{{ticket_number}}"
        meId={ME}
        role="agent"
      />,
      { locale: 'en' },
    );
    const select = await screen.findByRole('combobox', { name: m.templates });
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, 'Hello');
    expect(box().value).toBe('Hi {{ticket_number}}, about HD-1042');
  });

  it('a failed send keeps the text AND the message id, so the retry cannot create a duplicate; success changes the id', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${API}/tickets/${TID}/messages`, async ({ request }) => {
        sent.push((await request.json()) as Record<string, unknown>);
        return sent.length === 1
          ? HttpResponse.error()
          : HttpResponse.json(
              { message: {}, ticket: ticketBody.ticket, replayed: false, spawnedFrom: null },
              { status: 201 },
            );
      }),
    );
    staff();
    await user.type(box(), 'important');
    await user.click(screen.getByRole('button', { name: MESSAGES.en.ticket.reply.send }));
    expect(await screen.findByTestId('send-error')).toBeInTheDocument();
    expect(box().value).toBe('important');
    await user.click(screen.getByRole('button', { name: MESSAGES.en.ticket.reply.send }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.id).toBe(sent[0]?.id);
    await waitFor(() => expect(box().value).toBe(''));
    await user.type(box(), 'next one');
    await user.click(screen.getByRole('button', { name: MESSAGES.en.ticket.reply.send }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]?.id).not.toBe(sent[0]?.id);
  });

  it('a double click sends one request', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${API}/tickets/${TID}/messages`, async ({ request }) => {
        sent.push((await request.json()) as Record<string, unknown>);
        await new Promise((r) => setTimeout(r, 120));
        return HttpResponse.json(
          { message: {}, ticket: ticketBody.ticket, replayed: false, spawnedFrom: null },
          { status: 201 },
        );
      }),
    );
    staff();
    await user.type(box(), 'once');
    await user.dblClick(screen.getByRole('button', { name: MESSAGES.en.ticket.reply.send }));
    await waitFor(() => expect(box().value).toBe(''));
    expect(sent).toHaveLength(1);
  });
});

describe('drafts (acceptance #15: reload with a half-written reply)', () => {
  it('the text and the mode are restored after a reload (unmount + mount), per ticket', async () => {
    const user = userEvent.setup();
    const first = staff();
    await user.click(screen.getByRole('radio', { name: m.modeNote }));
    await user.type(box(), 'half-written thought');
    first.unmount(); // flushes the debounced save, like leaving the page
    staff();
    expect(box().value).toBe('half-written thought');
    expect(screen.getByRole('radio', { name: m.modeNote })).toBeChecked();
  });
  it('another ticket and another account do not see it', async () => {
    const user = userEvent.setup();
    const first = staff();
    await user.type(box(), 'for ticket one');
    first.unmount();
    renderApp(
      <ReplyComposer
        ticketId="55555555-5555-4555-8555-555555555555"
        ticketCode="HD-9"
        customerName="X"
        meId={ME}
        role="agent"
      />,
      { locale: 'en' },
    );
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    document.body.innerHTML = '';
    renderApp(
      <ReplyComposer
        ticketId={TID}
        ticketCode="HD-1042"
        customerName="X"
        meId="99999999-9999-4999-8999-999999999999"
        role="agent"
      />,
      { locale: 'en' },
    );
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });
  it('a sent message clears the draft; a corrupt stored draft is ignored', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(`helpdesk:draft:reply:${ME}:${TID}`, '{not json');
    staff();
    expect(box().value).toBe('');
    await user.type(box(), 'x');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() =>
      expect(window.localStorage.getItem(`helpdesk:draft:reply:${ME}:${TID}`)).toBeNull(),
    );
  });
});

describe('ReplyComposer (customer)', () => {
  it('has no mode switch, no templates, no staff buttons, and always sends a public message', async () => {
    const user = userEvent.setup();
    renderApp(
      <ReplyComposer
        ticketId={TID}
        ticketCode="HD-1042"
        customerName="Олена"
        meId={ME}
        role="customer"
      />,
      { locale: 'en' },
    );
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: m.sendAndWait })).not.toBeInTheDocument();
    await user.type(box(), 'hello support');
    await user.click(screen.getByRole('button', { name: MESSAGES.en.ticket.reply.send }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ kind: 'public' });
    expect(sent[0]).not.toHaveProperty('setStatus');
  });
  it('a server refusal is shown in words (409 closed ticket etc.), not swallowed', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${API}/tickets/${TID}/messages`, () =>
        envelope(409, 'invalid_transition', 'closed'),
      ),
    );
    renderApp(
      <ReplyComposer
        ticketId={TID}
        ticketCode="HD-1042"
        customerName="Олена"
        meId={ME}
        role="customer"
      />,
      { locale: 'en' },
    );
    await user.type(box(), 'hi');
    await user.click(screen.getByRole('button', { name: MESSAGES.en.ticket.reply.send }));
    expect(await screen.findByTestId('send-error')).toBeInTheDocument();
    expect(within(screen.getByTestId('send-error')).getByText(/./)).toBeTruthy();
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  API,
  CUSTOMER,
  ME,
  MESSAGES,
  envelope,
  http,
  HttpResponse,
  renderApp,
  router,
  server,
} from '../../../../test/utils';
import { LoginForm } from './login-form';

vi.mock('next/navigation', async () => {
  const utils = await import('../../../../test/utils');
  return { useRouter: () => utils.router, usePathname: () => '/login' };
});

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => router.replace.mockClear());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const field = (name: RegExp) => screen.getByLabelText(name) as HTMLInputElement;

describe.each([['uk' as const], ['en' as const]])('LoginForm (%s)', (locale) => {
  const m = MESSAGES[locale];
  const labels = {
    email: new RegExp(m.auth.email, 'i'),
    password: new RegExp(m.auth.password, 'i'),
  };
  const submit = () => screen.getByRole('button', { name: m.auth.submit });

  it('empty submit shows a translated error under EACH field, wired with aria-invalid + aria-describedby, and focuses the first', async () => {
    const user = userEvent.setup();
    renderApp(<LoginForm />, { locale });
    await user.click(submit());
    const email = field(labels.email);
    const password = field(labels.password);
    await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'));
    expect(password).toHaveAttribute('aria-invalid', 'true');
    for (const input of [email, password]) {
      const errorEl = document.getElementById(input.getAttribute('aria-describedby') ?? '');
      expect(errorEl, `${input.id} has a linked error element`).not.toBeNull();
      expect(errorEl).toHaveTextContent(m.validation.required);
      expect(errorEl).toHaveAttribute('role', 'alert');
    }
    expect(email).toHaveFocus(); // keyboard / screen-reader users land on the first problem
  });

  it('an invalid email says so (and only for that field); fixing it clears the error', async () => {
    const user = userEvent.setup();
    renderApp(<LoginForm />, { locale });
    await user.type(field(labels.email), 'not-an-email');
    await user.type(field(labels.password), 'secret');
    await user.click(submit());
    expect(await screen.findByText(m.validation.email)).toBeInTheDocument();
    expect(field(labels.password)).not.toHaveAttribute('aria-invalid', 'true');
    await user.clear(field(labels.email));
    await user.type(field(labels.email), 'ok@x.test');
    await waitFor(() => expect(screen.queryByText(m.validation.email)).not.toBeInTheDocument());
    expect(field(labels.email)).toHaveAttribute('aria-invalid', 'false');
  });

  it('too-long password: the limit is quoted with the correct plural form', async () => {
    const user = userEvent.setup();
    renderApp(<LoginForm />, { locale });
    await user.type(field(labels.email), 'a@b.co');
    await user.click(field(labels.password));
    await user.paste('x'.repeat(129));
    await user.click(submit());
    expect(
      await screen.findByText(
        locale === 'uk' ? /Не більше 128 символів/ : /At most 128 characters/,
      ),
    ).toBeInTheDocument();
  });

  it('wrong credentials → one announced alert, the fields stay filled, no navigation', async () => {
    server.use(
      http.post(`${API}/auth/login`, () =>
        envelope(401, 'unauthenticated', 'Invalid email or password'),
      ),
    );
    const user = userEvent.setup();
    renderApp(<LoginForm />, { locale });
    await user.type(field(labels.email), 'agent@x.test');
    await user.type(field(labels.password), 'wrong');
    await user.click(submit());
    const alert = await screen.findByTestId('login-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent(m.errors.invalidCredentials);
    expect(field(labels.email).value).toBe('agent@x.test');
    expect(field(labels.password).value).toBe('wrong');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it.each([
    [
      'rate limited',
      () => envelope(429, 'rate_limited', 'slow', { retryAfterSeconds: 5 }),
      () => (locale === 'uk' ? /5 секунд/ : /5 seconds/),
    ],
    [
      '1 second uses the singular',
      () => envelope(429, 'rate_limited', 'slow', { retryAfterSeconds: 1 }),
      () => (locale === 'uk' ? /1 секунду/ : /1 second\b/),
    ],
    [
      '21 seconds (uk "21 секунду")',
      () => envelope(429, 'rate_limited', 'slow', { retryAfterSeconds: 21 }),
      () => (locale === 'uk' ? /21 секунду/ : /21 seconds/),
    ],
    [
      'server down',
      () => envelope(503, 'service_unavailable'),
      (mm: typeof m) => new RegExp(mm.errors.unavailable.slice(0, 20)),
    ],
    [
      'bad gateway HTML',
      () => new HttpResponse('<html/>', { status: 502 }),
      (mm: typeof m) => new RegExp(mm.errors.server.slice(0, 20)),
    ],
    [
      'network failure',
      () => HttpResponse.error(),
      (mm: typeof m) => new RegExp(mm.errors.network.slice(0, 20)),
    ],
  ])('%s → the right localised message', async (_n, respond, expected) => {
    server.use(http.post(`${API}/auth/login`, respond));
    const user = userEvent.setup();
    renderApp(<LoginForm />, { locale });
    await user.type(field(labels.email), 'a@b.co');
    await user.type(field(labels.password), 'pw');
    await user.click(submit());
    expect(await screen.findByTestId('login-error')).toHaveTextContent(expected(m));
  });

  it('a double click sends ONE request; the button is busy and disabled meanwhile', async () => {
    let calls = 0;
    server.use(
      http.post(`${API}/auth/login`, async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 150));
        return HttpResponse.json({ user: ME });
      }),
    );
    const user = userEvent.setup();
    renderApp(<LoginForm />, { locale });
    await user.type(field(labels.email), 'agent@x.test');
    await user.type(field(labels.password), 'pw');
    await user.dblClick(submit());
    await waitFor(() => expect(screen.getByRole('button')).toBeDisabled());
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(calls).toBe(1);
  });

  it("success sends trimmed / lower-cased credentials and goes to the role's home (agent → queue, customer → tickets)", async () => {
    const bodies: unknown[] = [];
    for (const [u, path] of [
      [ME, '/queue'],
      [CUSTOMER, '/tickets'],
    ] as const) {
      server.use(
        http.post(`${API}/auth/login`, async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json({ user: u });
        }),
      );
      const user = userEvent.setup();
      const { unmount } = renderApp(<LoginForm />, { locale });
      await user.type(field(labels.email), '  Agent@X.TEST ');
      await user.type(field(labels.password), 'pw');
      await user.click(submit());
      await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith(path));
      unmount();
    }
    expect(bodies[0]).toEqual({ email: 'agent@x.test', password: 'pw' });
  });

  it('the inputs carry the attributes password managers and assistive tech rely on', () => {
    renderApp(<LoginForm />, { locale });
    expect(field(labels.email)).toHaveAttribute('type', 'email');
    expect(field(labels.email)).toHaveAttribute('autocomplete', 'username');
    expect(field(labels.password)).toHaveAttribute('type', 'password');
    expect(field(labels.password)).toHaveAttribute('autocomplete', 'current-password');
    expect(document.querySelector('form')).toHaveAttribute('novalidate');
  });

  it('the whole form works from the keyboard: Tab order email → password → submit, Enter submits', async () => {
    server.use(http.post(`${API}/auth/login`, () => HttpResponse.json({ user: ME })));
    const user = userEvent.setup();
    renderApp(<LoginForm />, { locale });
    await user.tab();
    expect(field(labels.email)).toHaveFocus();
    await user.keyboard('a@b.co');
    await user.tab();
    expect(field(labels.password)).toHaveFocus();
    await user.keyboard('pw{Enter}');
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/queue'));
  });
});

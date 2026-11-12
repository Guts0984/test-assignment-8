import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { act } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LoginPage } from '@/pages/login';
import { LocalTime } from '@/shared/ui/local-time';
import { API, Wrapper, envelope, http, server } from './utils';

vi.mock('next/navigation', async () => {
  const utils = await import('./utils');
  return { useRouter: () => utils.router, usePathname: () => '/login' };
});
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

beforeAll(() => server.listen({ onUnhandledFrame: 'bypass' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Server-render, then hydrate in the "browser": React logs any mismatch via console.error (acceptance #17). */
const hydrationProblems = async (tree: React.ReactElement): Promise<string[]> => {
  const html = renderToString(tree);
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  const problems: string[] = [];
  const spy = vi
    .spyOn(console, 'error')
    .mockImplementation((...args) => void problems.push(args.map(String).join(' ')));
  const warn = vi
    .spyOn(console, 'warn')
    .mockImplementation((...args) => void problems.push(args.map(String).join(' ')));
  await act(async () => {
    hydrateRoot(container, tree, {
      onRecoverableError: (e) => problems.push(`recoverable: ${String(e)}`),
    });
  });
  spy.mockRestore();
  warn.mockRestore();
  container.remove();
  return problems;
};

describe('hydration (acceptance #17)', () => {
  it.each(['uk', 'en'] as const)(
    'the login page hydrates without a single mismatch warning (%s)',
    async (locale) => {
      server.use(http.get(`${API}/me`, () => envelope(401, 'unauthenticated')));
      expect(
        await hydrationProblems(
          <Wrapper locale={locale}>
            <LoginPage />
          </Wrapper>,
        ),
      ).toEqual([]);
    },
  );

  it("dates (which depend on the browser's time zone) hydrate cleanly: the server renders a placeholder, the browser fills it in", async () => {
    const tree = (
      <Wrapper locale="en">
        <p>
          <LocalTime value="2026-11-12T23:30:00Z" />{' '}
          <LocalTime value="2026-11-12T23:30:00Z" kind="relative" />
        </p>
      </Wrapper>
    );
    const html = renderToString(tree);
    expect(html.replace(/<[^>]*>/g, '')).not.toMatch(/2026|Nov|лист/); // visible text: the server cannot know the viewer's zone, so it prints nothing zone-dependent
    expect(await hydrationProblems(tree)).toEqual([]);
  });

  it('the server HTML of the login page already contains the form and landmarks (usable before JS runs)', () => {
    const html = renderToString(
      <Wrapper locale="uk">
        <LoginPage />
      </Wrapper>,
    );
    expect(html).toContain('<main');
    expect(html).toContain('<form');
    expect(html).toContain('type="password"');
  });
});

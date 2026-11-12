import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor, act } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { API, ME, envelope, http, HttpResponse, makeClient, server } from '../../../../test/utils';
import { fetchMe, homePathFor, sessionKeys, useLogin, useLogout, useMe } from './session';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const wrap = (client = makeClient()) => ({
  client,
  wrapper: ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  ),
});

describe('session', () => {
  it('a 401 on /me means "nobody is signed in" (null), not an error', async () => {
    server.use(http.get(`${API}/me`, () => envelope(401, 'unauthenticated')));
    expect(await fetchMe()).toBeNull();
    const { wrapper } = wrap();
    const { result } = renderHook(() => useMe(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
  it('other failures (server down) ARE errors, so the UI does not pretend you are signed out', async () => {
    server.use(http.get(`${API}/me`, () => envelope(503, 'service_unavailable')));
    await expect(fetchMe()).rejects.toMatchObject({ info: { status: 503 } });
  });
  it('login stores the user in the cache; logout empties it AND everything else cached (no data of the previous user survives)', async () => {
    server.use(
      http.post(`${API}/auth/login`, () => HttpResponse.json({ user: ME })),
      http.post(`${API}/auth/logout`, () => new HttpResponse(null, { status: 204 })),
    );
    const { client, wrapper } = wrap();
    const login = renderHook(() => useLogin(), { wrapper });
    await act(async () => {
      await login.result.current.mutateAsync({ email: 'a@b.co', password: 'x' });
    });
    expect(client.getQueryData(sessionKeys.me)).toMatchObject({ role: 'agent' });
    client.setQueryData(['tickets', 'list'], [{ secret: 'previous user data' }]);
    const logout = renderHook(() => useLogout(), { wrapper });
    await act(async () => {
      await logout.result.current.mutateAsync();
    });
    expect(client.getQueryData(sessionKeys.me)).toBeNull();
    expect(client.getQueryData(['tickets', 'list'])).toBeUndefined();
  });
  it('logout clears the local state even when the request fails (a dead network must not keep you "signed in" on screen)', async () => {
    server.use(http.post(`${API}/auth/logout`, () => HttpResponse.error()));
    const { client, wrapper } = wrap();
    client.setQueryData(sessionKeys.me, ME);
    const logout = renderHook(() => useLogout(), { wrapper });
    await act(async () => {
      await logout.result.current.mutateAsync().catch(() => undefined);
    });
    expect(client.getQueryData(sessionKeys.me)).toBeNull();
  });
  it('each role lands on its own home', () => {
    expect(homePathFor('customer')).toBe('/tickets');
    expect(homePathFor('agent')).toBe('/queue');
    expect(homePathFor('lead')).toBe('/queue');
  });
});

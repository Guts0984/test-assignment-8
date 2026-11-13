import { describe, expect, it } from 'vitest';
import { canOpen } from './route-access';

describe('canOpen', () => {
  it.each([
    ['/queue', 'customer', false],
    ['/queue', 'agent', true],
    ['/queue', 'lead', true],
    ['/dashboard', 'agent', false],
    ['/dashboard', 'lead', true],
    ['/dashboard', 'customer', false],
    ['/settings', 'agent', false],
    ['/settings', 'lead', true],
    ['/tickets', 'customer', true],
    ['/tickets', 'agent', false],
    ['/tickets/new', 'customer', true],
    ['/tickets/new', 'lead', false],
    ['/tickets/5f0c1c7e-1111-4111-8111-111111111111', 'customer', true],
    ['/tickets/5f0c1c7e-1111-4111-8111-111111111111', 'agent', true],
    ['/queue/', 'customer', false], // a trailing slash is the same page
    ['/login', 'customer', true],
  ] as const)('%s for %s → %s', (path, role, ok) => expect(canOpen(path, role)).toBe(ok));
});

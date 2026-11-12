import { describe, expect, it } from 'vitest';
import {
  ALL_STATUS_PAIRS,
  MESSAGE_KINDS,
  ROLES,
  STATUSES,
  allowedTransitions,
  canTransition,
  slaClockRunning,
  statusAfterMessage,
} from '../src';

// Independent oracle, written as an explicit list so a typo in the table is caught.
const STAFF_OK = new Set([
  'new>open',
  'new>pending',
  'new>resolved',
  'open>pending',
  'open>resolved',
  'pending>open',
  'pending>resolved',
  'resolved>open',
  'resolved>closed',
]);
const CUSTOMER_OK = new Set(['new>resolved', 'open>resolved', 'pending>resolved']);

describe('canTransition: exhaustive over every pair and role', () => {
  for (const [from, to] of ALL_STATUS_PAIRS) {
    it(`staff ${from} -> ${to}`, () => {
      const expected = STAFF_OK.has(`${from}>${to}`);
      expect(canTransition(from, to, 'agent')).toBe(expected);
      expect(canTransition(from, to, 'lead')).toBe(expected);
    });
    it(`customer ${from} -> ${to}`, () => {
      expect(canTransition(from, to, 'customer')).toBe(CUSTOMER_OK.has(`${from}>${to}`));
    });
  }

  it('nothing ever leaves closed, for any role', () => {
    for (const role of ROLES)
      for (const to of STATUSES) expect(canTransition('closed', to, role)).toBe(false);
  });
  it('nothing ever goes back to new, and no self-transitions', () => {
    for (const role of ROLES)
      for (const s of STATUSES) {
        expect(canTransition(s, 'new', role)).toBe(false);
        expect(canTransition(s, s, role)).toBe(false);
      }
  });
  it('customers can never close or reopen by hand', () => {
    for (const s of STATUSES) {
      expect(canTransition(s, 'closed', 'customer')).toBe(false);
      expect(canTransition(s, 'open', 'customer')).toBe(false);
    }
  });
  it('allowedTransitions agrees with canTransition', () => {
    for (const role of ROLES)
      for (const from of STATUSES)
        for (const to of STATUSES)
          expect(allowedTransitions(from, role).includes(to)).toBe(canTransition(from, to, role));
  });
});

describe('statusAfterMessage', () => {
  it('agent public reply on new/pending -> open', () => {
    for (const status of ['new', 'pending'] as const)
      expect(statusAfterMessage({ status, authorRole: 'agent', kind: 'public' })).toEqual({
        type: 'set',
        status: 'open',
      });
  });
  it('customer reply on pending/resolved -> open', () => {
    for (const status of ['pending', 'resolved'] as const)
      expect(statusAfterMessage({ status, authorRole: 'customer', kind: 'public' })).toEqual({
        type: 'set',
        status: 'open',
      });
  });
  it('customer reply on closed spawns a linked ticket', () => {
    expect(
      statusAfterMessage({ status: 'closed', authorRole: 'customer', kind: 'public' }),
    ).toEqual({ type: 'spawn-linked-ticket' });
  });
  it('internal notes never change status, for any starting status', () => {
    for (const status of STATUSES.filter((s) => s !== 'closed'))
      for (const authorRole of ['agent', 'lead'] as const)
        expect(statusAfterMessage({ status, authorRole, kind: 'internal' })).toEqual({
          type: 'keep',
        });
  });
  it('a customer can never post an internal note', () => {
    for (const status of STATUSES)
      expect(statusAfterMessage({ status, authorRole: 'customer', kind: 'internal' })).toEqual({
        type: 'reject',
        reason: 'internal_note_by_customer',
      });
  });
  it('staff cannot post anything on a closed ticket', () => {
    for (const kind of MESSAGE_KINDS)
      expect(statusAfterMessage({ status: 'closed', authorRole: 'agent', kind })).toEqual({
        type: 'reject',
        reason: 'closed_ticket_staff_reply',
      });
  });
  it('agent reply on resolved/open keeps status', () => {
    for (const status of ['open', 'resolved'] as const)
      expect(statusAfterMessage({ status, authorRole: 'agent', kind: 'public' })).toEqual({
        type: 'keep',
      });
  });
  it('every outcome set by a reply is a legal state (never new/closed)', () => {
    for (const status of STATUSES)
      for (const authorRole of ROLES)
        for (const kind of MESSAGE_KINDS) {
          const o = statusAfterMessage({ status, authorRole, kind });
          if (o.type === 'set') expect(['open']).toContain(o.status);
        }
  });
});

describe('slaClockRunning', () => {
  it('runs only in new/open (pending pauses)', () => {
    expect(STATUSES.filter(slaClockRunning)).toEqual(['new', 'open']);
  });
});

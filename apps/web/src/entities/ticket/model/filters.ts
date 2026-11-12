import {
  CATEGORIES,
  PRIORITIES,
  STATUSES,
  type Category,
  type Priority,
  type TicketStatus,
} from '@helpdesk/shared';
import type { SortKey } from './overlay';

export type TicketFilters = {
  status: TicketStatus[];
  priority: Priority[];
  category: Category[];
  assignee: 'me' | 'none' | string | null;
  slaBreached: boolean | null;
  tags: string[];
  createdFrom: string | null;
  createdTo: string | null;
  q: string;
  sort: SortKey;
  order: 'asc' | 'desc';
};

export const DEFAULT_FILTERS: TicketFilters = {
  status: [],
  priority: [],
  category: [],
  assignee: null,
  slaBreached: null,
  tags: [],
  createdFrom: null,
  createdTo: null,
  q: '',
  sort: 'created',
  order: 'desc',
};

type Params = Pick<URLSearchParams, 'get'>;
const pick = <T extends string>(raw: string | null, allowed: readonly T[]): T[] =>
  (raw ?? '').split(',').filter((v): v is T => (allowed as readonly string[]).includes(v));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;

/**
 * The URL is the source of truth for the queue's filters (so reload and Back restore them).
 * Anything unknown or malformed in a hand-edited URL is silently ignored, never an error.
 */
export const parseFilters = (params: Params): TicketFilters => {
  const assignee = params.get('assignee');
  const sort = params.get('sort');
  const from = params.get('createdFrom');
  const to = params.get('createdTo');
  return {
    status: pick(params.get('status'), STATUSES),
    priority: pick(params.get('priority'), PRIORITIES),
    category: pick(params.get('category'), CATEGORIES),
    assignee:
      assignee === 'me' || assignee === 'none' || (assignee && UUID.test(assignee))
        ? assignee
        : null,
    slaBreached:
      params.get('slaBreached') === 'true'
        ? true
        : params.get('slaBreached') === 'false'
          ? false
          : null,
    tags: (params.get('tags') ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0 && t.length <= 40)
      .slice(0, 20),
    createdFrom: from && ISO.test(from) ? from : null,
    createdTo: to && ISO.test(to) ? to : null,
    q: (params.get('q') ?? '').slice(0, 200),
    sort: sort === 'sla' || sort === 'updated' || sort === 'created' ? sort : DEFAULT_FILTERS.sort,
    order: params.get('order') === 'asc' ? 'asc' : 'desc',
  };
};

/** Only non-default values go into the URL, so the default view has a clean `/queue`. */
export const serializeFilters = (f: TicketFilters): string => {
  const p = new URLSearchParams();
  if (f.status.length) p.set('status', f.status.join(','));
  if (f.priority.length) p.set('priority', f.priority.join(','));
  if (f.category.length) p.set('category', f.category.join(','));
  if (f.assignee) p.set('assignee', f.assignee);
  if (f.slaBreached !== null) p.set('slaBreached', String(f.slaBreached));
  if (f.tags.length) p.set('tags', f.tags.join(','));
  if (f.createdFrom) p.set('createdFrom', f.createdFrom);
  if (f.createdTo) p.set('createdTo', f.createdTo);
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.sort !== DEFAULT_FILTERS.sort) p.set('sort', f.sort);
  if (f.order !== DEFAULT_FILTERS.order) p.set('order', f.order);
  return p.toString();
};

/** Query for GET /tickets (the API's own names). */
export const toApiQuery = (
  f: TicketFilters,
): Record<string, string | boolean | readonly string[] | undefined> => ({
  status: f.status,
  priority: f.priority,
  category: f.category,
  tags: f.tags,
  ...(f.assignee ? { assignee: f.assignee } : {}),
  ...(f.slaBreached !== null ? { slaBreached: f.slaBreached } : {}),
  ...(f.createdFrom ? { createdFrom: f.createdFrom } : {}),
  ...(f.createdTo ? { createdTo: f.createdTo } : {}),
  ...(f.q.trim() ? { q: f.q.trim() } : {}),
  sort: f.sort,
  order: f.order,
});

type Matchable = {
  status: string;
  priority: string;
  category: string;
  assignee: { id: string } | null;
  tags: string[];
  createdAt: string;
  sla: { breached: boolean } | null;
};

/** Does a ticket belong in the list for these filters? (Used to place/remove live updates; the server stays the authority.) */
export const ticketMatches = (f: TicketFilters, t: Matchable, meId: string): boolean =>
  (f.status.length === 0 || (f.status as string[]).includes(t.status)) &&
  (f.priority.length === 0 || (f.priority as string[]).includes(t.priority)) &&
  (f.category.length === 0 || (f.category as string[]).includes(t.category)) &&
  (f.assignee === null ||
    (f.assignee === 'none'
      ? t.assignee === null
      : f.assignee === 'me'
        ? t.assignee?.id === meId
        : t.assignee?.id === f.assignee)) &&
  (f.slaBreached === null || (t.sla?.breached ?? false) === f.slaBreached) &&
  f.tags.every((tag) => t.tags.includes(tag)) &&
  (!f.createdFrom || t.createdAt >= f.createdFrom) &&
  (!f.createdTo || t.createdAt <= f.createdTo);

export type BuiltInView = {
  id: string;
  labelKey: 'myOpen' | 'unassigned' | 'slaBurning';
  filters: Partial<TicketFilters>;
};
export const BUILT_IN_VIEWS: readonly BuiltInView[] = [
  { id: 'my-open', labelKey: 'myOpen', filters: { assignee: 'me', status: ['new', 'open'] } },
  {
    id: 'unassigned',
    labelKey: 'unassigned',
    filters: { assignee: 'none', status: ['new', 'open'] },
  },
  {
    id: 'sla-burning',
    labelKey: 'slaBurning',
    filters: { slaBreached: true, status: ['new', 'open'], sort: 'sla', order: 'asc' },
  },
];

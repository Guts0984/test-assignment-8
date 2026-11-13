import type { Role } from '@helpdesk/shared';

/**
 * Which roles may see which page. The server is the authority (403 on every action); this keeps a signed-in user from
 * landing on a screen full of buttons that can only fail (a customer on /queue, an agent on /settings).
 */
const RULES: ReadonlyArray<{ test: (p: string) => boolean; roles: readonly Role[] }> = [
  { test: (p) => p === '/queue' || p.startsWith('/queue/'), roles: ['agent', 'lead'] },
  { test: (p) => p === '/dashboard' || p.startsWith('/dashboard/'), roles: ['lead'] },
  { test: (p) => p === '/settings' || p.startsWith('/settings/'), roles: ['lead'] },
  // the customer's own list and "new ticket"; /tickets/<id> is for everyone (the server decides which tickets)
  { test: (p) => p === '/tickets' || p === '/tickets/new', roles: ['customer'] },
];

export const canOpen = (pathname: string, role: Role): boolean => {
  const path = pathname.replace(/\/+$/, '') || '/';
  const rule = RULES.find((r) => r.test(path));
  return rule ? rule.roles.includes(role) : true;
};

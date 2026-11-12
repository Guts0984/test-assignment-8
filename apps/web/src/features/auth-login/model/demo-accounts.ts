import type { Category, Role } from '@helpdesk/shared';

export type DemoAccount = {
  email: string;
  password: string;
  role: Role;
  categories: readonly Category[];
};

/** The seeded demo accounts (see packages/db/README.md). Public on purpose: this is a test assignment. */
export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { email: 'lead@helpdesk.test', password: 'Lead#2026pass', role: 'lead', categories: [] },
  {
    email: 'agent1@helpdesk.test',
    password: 'Agent#2026pass',
    role: 'agent',
    categories: ['payment', 'other'],
  },
  {
    email: 'agent2@helpdesk.test',
    password: 'Agent#2026pass',
    role: 'agent',
    categories: ['delivery', 'other'],
  },
  {
    email: 'agent3@helpdesk.test',
    password: 'Agent#2026pass',
    role: 'agent',
    categories: ['account', 'technical'],
  },
  {
    email: 'agent4@helpdesk.test',
    password: 'Agent#2026pass',
    role: 'agent',
    categories: ['technical', 'payment'],
  },
  {
    email: 'agent5@helpdesk.test',
    password: 'Agent#2026pass',
    role: 'agent',
    categories: ['delivery', 'account'],
  },
  {
    email: 'agent6@helpdesk.test',
    password: 'Agent#2026pass',
    role: 'agent',
    categories: ['other', 'payment', 'delivery'],
  },
  {
    email: 'customer001@helpdesk.test',
    password: 'Customer#2026pass',
    role: 'customer',
    categories: [],
  },
  {
    email: 'customer002@helpdesk.test',
    password: 'Customer#2026pass',
    role: 'customer',
    categories: [],
  },
  {
    email: 'customer003@helpdesk.test',
    password: 'Customer#2026pass',
    role: 'customer',
    categories: [],
  },
];

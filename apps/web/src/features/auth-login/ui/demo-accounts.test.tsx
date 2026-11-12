import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MESSAGES, renderApp } from '../../../../test/utils';
import { DEMO_ACCOUNTS } from '../model/demo-accounts';
import { DemoAccounts } from './demo-accounts';

describe('DemoAccounts', () => {
  it('lists the lead, all six agents and customers with public passwords', () => {
    renderApp(<DemoAccounts onPick={() => {}} />, { locale: 'en' });
    expect(DEMO_ACCOUNTS.filter((a) => a.role === 'agent')).toHaveLength(6);
    for (const a of DEMO_ACCOUNTS) {
      expect(screen.getByText(a.email)).toBeInTheDocument();
    }
    expect(screen.getAllByText('Agent#2026pass')).toHaveLength(6);
  });

  it('pressing Fill in hands the picked account to the form', async () => {
    const onPick = vi.fn();
    renderApp(<DemoAccounts onPick={onPick} />, { locale: 'en' });
    const label = MESSAGES.en.auth.demo.fillAria.replace('{email}', 'lead@helpdesk.test');
    await userEvent.setup().click(screen.getByRole('button', { name: label }));
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'lead@helpdesk.test', password: 'Lead#2026pass' }),
    );
  });
});

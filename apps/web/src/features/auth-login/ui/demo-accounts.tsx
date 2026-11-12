'use client';
import { useTranslations } from 'next-intl';
import type { Role } from '@helpdesk/shared';
import { Button } from '@/shared/ui/button';
import { DEMO_ACCOUNTS, type DemoAccount } from '../model/demo-accounts';

const GROUPS: Array<{ role: Role; key: 'lead' | 'agents' | 'customers' }> = [
  { role: 'lead', key: 'lead' },
  { role: 'agent', key: 'agents' },
  { role: 'customer', key: 'customers' },
];

/** Every seeded account with its password; one press fills the sign-in form. */
export const DemoAccounts = ({ onPick }: { onPick: (a: DemoAccount) => void }) => {
  const t = useTranslations('auth.demo');
  const tc = useTranslations('category');
  return (
    <section
      aria-labelledby="demo-title"
      className="grid gap-3 rounded-lg border border-border p-4 text-sm"
    >
      <h2 id="demo-title" className="text-base font-semibold">
        {t('title')}
      </h2>
      <p className="text-muted-foreground">{t('hint')}</p>
      {GROUPS.map((g) => (
        <div key={g.role} className="grid gap-1.5">
          <h3 className="font-medium">{t(g.key)}</h3>
          <ul className="grid gap-1.5">
            {DEMO_ACCOUNTS.filter((a) => a.role === g.role).map((a) => (
              <li key={a.email} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono">{a.email}</span>
                <span className="text-muted-foreground">
                  {t('password')}: <span className="font-mono text-foreground">{a.password}</span>
                </span>
                {a.categories.length > 0 ? (
                  <span className="text-muted-foreground">
                    · {a.categories.map((c) => tc(c)).join(', ')}
                  </span>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  aria-label={t('fillAria', { email: a.email })}
                  onClick={() => onPick(a)}
                >
                  {t('fill')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
};

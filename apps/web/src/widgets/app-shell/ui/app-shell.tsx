'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { LogOut } from 'lucide-react';
import type { Me } from '@helpdesk/shared';
import { useLogout, useMe } from '@/entities/session/api/session';
import { LiveUpdates } from '@/features/realtime/ui/live-updates';
import { NotificationBell } from '@/features/notifications/ui/notification-bell';
import { LocaleSwitch } from '@/features/switch-locale/ui/locale-switch';
import { ThemeSelect } from '@/features/toggle-theme/ui/theme-select';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';

const navFor = (
  role: Me['role'],
): Array<{
  href: string;
  label: 'myTickets' | 'queue' | 'dashboard' | 'settings' | 'newTicket';
}> =>
  role === 'customer'
    ? [{ href: '/tickets', label: 'myTickets' }]
    : [
        { href: '/queue', label: 'queue' },
        ...(role === 'lead'
          ? ([
              { href: '/dashboard', label: 'dashboard' },
              { href: '/settings', label: 'settings' },
            ] as const)
          : []),
      ];

/** Header + navigation + the `main` landmark (the target of the skip link). */
export const AppShell = ({ children }: { children: ReactNode }) => {
  const t = useTranslations();
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const me = useMe();
  const logout = useLogout();

  useEffect(() => {
    if (me.data === null) router.replace('/login');
  }, [me.data, router]);

  if (me.isPending || me.data === null || me.data === undefined) {
    return (
      <p role="status" className="p-8 text-muted-foreground">
        {t('common.loading')}
      </p>
    );
  }
  const user = me.data;
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3">
          <span className="text-lg font-semibold">{t('app.name')}</span>
          <nav aria-label={t('nav.main')} className="flex gap-1">
            {navFor(user.role).map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'rounded-md px-3 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active && 'bg-accent',
                  )}
                >
                  {t(`nav.${item.label}`)}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {user.role !== 'customer' ? <NotificationBell /> : null}
            <LocaleSwitch />
            <ThemeSelect />
            <span className="text-sm text-muted-foreground">
              {user.name} · {t(`role.${user.role}`)}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                logout.mutate(undefined, { onSettled: () => router.replace('/login') })
              }
            >
              <LogOut aria-hidden="true" />
              {t('common.logout')}
            </Button>
          </div>
        </div>
      </header>
      <LiveUpdates meId={user.id} role={user.role} />
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 focus:outline-none"
      >
        {children}
      </main>
    </div>
  );
};

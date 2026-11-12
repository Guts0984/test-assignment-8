'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { homePathFor, useMe } from '@/entities/session/api/session';
import { DemoAccounts } from '@/features/auth-login/ui/demo-accounts';
import { LoginForm } from '@/features/auth-login/ui/login-form';
import { LocaleSwitch } from '@/features/switch-locale/ui/locale-switch';
import { ThemeSelect } from '@/features/toggle-theme/ui/theme-select';
import { useAnnounce } from '@/shared/ui/announcer';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';

export const LoginPage = () => {
  const t = useTranslations('auth');
  const router = useRouter();
  const me = useMe();
  const [prefill, setPrefill] = useState<{ email: string; password: string; nonce: number } | null>(
    null,
  );
  const announce = useAnnounce();
  const td = useTranslations('auth.demo');
  useEffect(() => {
    if (me.data) router.replace(homePathFor(me.data.role)); // already signed in
  }, [me.data, router]);
  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto grid min-h-screen max-w-2xl content-center gap-4 px-4 focus:outline-none"
    >
      <div className="flex justify-end gap-2">
        <LocaleSwitch />
        <ThemeSelect />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <LoginForm prefill={prefill} />
        </CardContent>
      </Card>
      <DemoAccounts
        onPick={(a) => {
          setPrefill({ email: a.email, password: a.password, nonce: Date.now() });
          announce(td('filled', { email: a.email }));
        }}
      />
    </main>
  );
};

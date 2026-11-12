'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { homePathFor, useMe } from '@/entities/session/api/session';
import { LoginForm } from '@/features/auth-login/ui/login-form';
import { LocaleSwitch } from '@/features/switch-locale/ui/locale-switch';
import { ThemeSelect } from '@/features/toggle-theme/ui/theme-select';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';

export const LoginPage = () => {
  const t = useTranslations('auth');
  const router = useRouter();
  const me = useMe();
  useEffect(() => {
    if (me.data) router.replace(homePathFor(me.data.role)); // already signed in
  }, [me.data, router]);
  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto grid min-h-screen max-w-md content-center gap-4 px-4 focus:outline-none"
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
          <LoginForm />
        </CardContent>
      </Card>
    </main>
  );
};

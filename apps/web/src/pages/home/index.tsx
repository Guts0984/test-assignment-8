'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { homePathFor, useMe } from '@/entities/session/api/session';

/** `/` just sends people where they belong: sign-in, their tickets, or the queue. */
export const HomePage = () => {
  const router = useRouter();
  const me = useMe();
  const t = useTranslations('common');
  useEffect(() => {
    if (me.isPending) return;
    router.replace(me.data ? homePathFor(me.data.role) : '/login');
  }, [me.isPending, me.data, router]);
  return (
    <p role="status" className="p-8 text-muted-foreground">
      {t('loading')}
    </p>
  );
};

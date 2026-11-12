'use client';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { loginSchema, type Me } from '@helpdesk/shared';
import type { z } from 'zod';
import { homePathFor, useLogin } from '@/entities/session/api/session';
import { isApiError } from '@/shared/api/client';
import { describeError } from '@/shared/lib/error-message';
import { zodFormResolver } from '@/shared/lib/form-resolver';
import { Alert } from '@/shared/ui/alert';
import { Button } from '@/shared/ui/button';
import { FormField } from '@/shared/ui/form-field';
import { Input } from '@/shared/ui/input';

type Values = z.input<typeof loginSchema>;

export const LoginForm = ({
  onSuccess,
  prefill,
}: {
  onSuccess?: (user: Me) => void;
  prefill?: { email: string; password: string; nonce: number } | null;
}) => {
  const t = useTranslations('auth');
  const te = useTranslations('errors');
  const router = useRouter();
  const login = useLogin();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setValue,
    clearErrors,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodFormResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  // the demo-accounts panel fills the form (nonce: picking the same account twice still refills it)
  useEffect(() => {
    if (!prefill) return;
    setValue('email', prefill.email, { shouldDirty: true });
    setValue('password', prefill.password, { shouldDirty: true });
    clearErrors();
    setServerError(null);
  }, [prefill, setValue, clearErrors]);

  const submit = handleSubmit(async (values) => {
    setServerError(null);
    try {
      const { user } = await login.mutateAsync(values);
      onSuccess?.(user);
      router.replace(homePathFor(user.role));
    } catch (e) {
      setServerError(
        isApiError(e)
          ? describeError(te, e.info, { unauthenticated: 'invalidCredentials' })
          : te('unknown'),
      );
    }
  });

  return (
    // noValidate: the browser's own bubbles would replace our (translated, screen-reader-linked) messages
    <form
      onSubmit={submit}
      noValidate
      className="grid gap-4"
      aria-describedby={serverError ? 'login-error' : undefined}
    >
      {serverError ? (
        <Alert id="login-error" data-testid="login-error">
          {serverError}
        </Alert>
      ) : null}
      <FormField id="email" label={t('email')} error={errors.email}>
        {(a11y) => (
          <Input
            {...a11y}
            type="email"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            {...register('email')}
          />
        )}
      </FormField>
      <FormField id="password" label={t('password')} error={errors.password}>
        {(a11y) => (
          <Input
            {...a11y}
            type="password"
            autoComplete="current-password"
            {...register('password')}
          />
        )}
      </FormField>
      <Button type="submit" disabled={isSubmitting} aria-busy={isSubmitting}>
        {isSubmitting ? t('submitting') : t('submit')}
      </Button>
    </form>
  );
};

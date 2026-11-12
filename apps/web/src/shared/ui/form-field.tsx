'use client';
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { decodeIssue } from '@/shared/lib/form-resolver';
import { Label } from './label';

type FieldError = { message?: string | undefined } | undefined;

/**
 * A labelled control whose error message is programmatically tied to it:
 * `aria-invalid` + `aria-describedby` (so a screen reader reads the error with the field) and the
 * message itself is announced when it appears (`role="alert"`). Validation messages are translated here.
 */
export const FormField = ({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: FieldError;
  hint?: string;
  children: (props: {
    id: string;
    'aria-invalid': boolean;
    'aria-describedby': string | undefined;
  }) => React.ReactNode;
}) => {
  const t = useTranslations('validation');
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const issue = error?.message ? decodeIssue(error.message) : null;
  const describedBy =
    [hint ? hintId : null, issue ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children({ id, 'aria-invalid': issue !== null, 'aria-describedby': describedBy })}
      {hint ? (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {issue ? (
        <p id={errorId} role="alert" className="text-sm font-medium text-destructive">
          {t(issue.key, { n: issue.n ?? 0 })}
        </p>
      ) : null}
    </div>
  );
};

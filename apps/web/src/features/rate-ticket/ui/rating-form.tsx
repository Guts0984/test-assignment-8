'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useRateTicket } from '@/entities/ticket/api/tickets';
import { isApiError } from '@/shared/api/client';
import { describeError } from '@/shared/lib/error-message';
import { useAnnounce } from '@/shared/ui/announcer';
import { Alert } from '@/shared/ui/alert';
import { Button } from '@/shared/ui/button';
import { Textarea } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';

/** 1–5 as a radio group (arrow keys work natively) + an optional comment. */
export const RatingForm = ({
  ticketId,
  existing,
}: {
  ticketId: string;
  existing: { score: number } | null;
}) => {
  const t = useTranslations();
  const rate = useRateTicket(ticketId);
  const announce = useAnnounce();
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (existing) return <p role="status">{t('ticket.rating.thanks', { score: existing.score })}</p>;
  return (
    <form
      className="grid gap-3 rounded-lg border border-border p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (score === null) return;
        setError(null);
        try {
          await rate.mutateAsync({ score, ...(comment.trim() ? { comment: comment.trim() } : {}) });
          announce(t('ticket.rating.thanks', { score }));
        } catch (err) {
          setError(
            isApiError(err)
              ? describeError((k, v) => t(`errors.${k}`, v), err.info)
              : t('errors.unknown'),
          );
        }
      }}
    >
      <fieldset className="grid gap-2">
        <legend className="font-semibold">{t('ticket.rating.title')}</legend>
        <div className="flex gap-3" role="radiogroup" aria-label={t('ticket.rating.score')}>
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="inline-flex items-center gap-1.5">
              <input
                type="radio"
                name={`score-${ticketId}`}
                value={n}
                checked={score === n}
                onChange={() => setScore(n)}
                aria-label={t('ticket.rating.star', { n })}
              />
              <span aria-hidden="true">{n}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-1.5">
        <Label htmlFor={`rc-${ticketId}`}>{t('ticket.rating.comment')}</Label>
        <Textarea
          id={`rc-${ticketId}`}
          rows={3}
          maxLength={2000}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <div>
        <Button type="submit" disabled={score === null || rate.isPending}>
          {t('ticket.rating.submit')}
        </Button>
      </div>
    </form>
  );
};

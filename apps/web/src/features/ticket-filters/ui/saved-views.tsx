'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useSavedViewMutations, useSavedViews } from '@/entities/agent/api/staff';
import { isApiError } from '@/shared/api/client';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import {
  BUILT_IN_VIEWS,
  DEFAULT_FILTERS,
  parseFilters,
  serializeFilters,
  toApiQuery,
  type TicketFilters,
} from '@/entities/ticket/model/filters';

/** "My open", "Unassigned", "SLA burning" and the user's own views. A view is just a set of filters. */
export const SavedViews = ({
  filters,
  onApply,
}: {
  filters: TicketFilters;
  onApply: (f: TicketFilters) => void;
}) => {
  const t = useTranslations('queue.views');
  const views = useSavedViews();
  const { create, remove } = useSavedViewMutations();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState(false);
  const current = serializeFilters(filters);

  return (
    <nav aria-label={t('label')} className="flex flex-wrap items-center gap-2">
      {BUILT_IN_VIEWS.map((v) => {
        const target = { ...DEFAULT_FILTERS, ...v.filters };
        const on = serializeFilters(target) === current;
        return (
          <Button
            key={v.id}
            variant={on ? 'default' : 'outline'}
            size="sm"
            aria-pressed={on}
            onClick={() => onApply(target)}
          >
            {t(v.labelKey)}
          </Button>
        );
      })}
      {views.data?.map((v) => {
        const target = parseFilters(
          new URLSearchParams(
            Object.entries(v.query).map(([k, val]) => [
              k,
              Array.isArray(val) ? val.join(',') : String(val),
            ]),
          ),
        );
        const on = serializeFilters(target) === current;
        return (
          <span key={v.id} className="inline-flex">
            <Button
              variant={on ? 'default' : 'outline'}
              size="sm"
              aria-pressed={on}
              className="rounded-r-none"
              onClick={() => onApply(target)}
            >
              {v.name}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-l-none border-l-0"
              aria-label={t('deleteView', { name: v.name })}
              onClick={() => remove.mutate(v.id)}
            >
              ×
            </Button>
          </span>
        );
      })}
      {naming ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError(false);
            create.mutate(
              { name: name.trim(), query: toApiQuery(filters) as Record<string, unknown> },
              {
                onSuccess: () => {
                  setNaming(false);
                  setName('');
                },
                onError: (err) => setError(isApiError(err) && err.info.status === 409),
              },
            );
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor="view-name" className="sr-only">
              {t('viewName')}
            </Label>
            <Input
              id="view-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('viewName')}
              maxLength={60}
              className="h-9"
              aria-invalid={error}
            />
          </div>
          <Button type="submit" size="sm" disabled={name.trim() === ''}>
            {t('saveView')}
          </Button>
          {error ? (
            <span role="alert" className="text-sm text-destructive">
              {t('exists')}
            </span>
          ) : null}
        </form>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => setNaming(true)}>
          {t('saveCurrent')}
        </Button>
      )}
    </nav>
  );
};

'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  CATEGORIES,
  TEMPLATE_VARIABLES,
  unknownPlaceholders,
  type CannedResponseDto,
} from '@helpdesk/shared';
import { useCanned, useCannedMutations } from '@/entities/agent/api/staff';
import { isApiError } from '@/shared/api/client';
import { describeError } from '@/shared/lib/error-message';
import { Alert } from '@/shared/ui/alert';
import { Button } from '@/shared/ui/button';
import { Input, Textarea } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Select } from '@/shared/ui/select';

type Draft = { id: string | null; title: string; body: string; category: string };
const EMPTY: Draft = { id: null, title: '', body: '', category: '' };

export const CannedManager = () => {
  const t = useTranslations();
  const ts = useTranslations('staff.settings');
  const list = useCanned();
  const { create, update, remove } = useCannedMutations();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const bad = unknownPlaceholders(draft.body);
  const submit = async () => {
    setError(null);
    const body = {
      title: draft.title.trim(),
      body: draft.body,
      category: (draft.category || null) as CannedResponseDto['category'],
    };
    try {
      if (draft.id) await update.mutateAsync({ id: draft.id, body });
      else await create.mutateAsync(body);
      setDraft(EMPTY);
    } catch (e) {
      setError(
        isApiError(e) ? describeError((k, v) => t(`errors.${k}`, v), e.info) : t('errors.unknown'),
      );
    }
  };
  return (
    <section aria-labelledby="tpl-title" className="grid gap-3">
      <h2 id="tpl-title" className="text-xl font-semibold">
        {ts('templates')}
      </h2>
      <p className="text-sm text-muted-foreground">{ts('templatesHelp')}</p>
      <ul className="grid gap-2">
        {list.data?.map((c) => (
          <li
            key={c.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2"
          >
            <span className="font-medium">{c.title}</span>
            <span className="text-sm text-muted-foreground">
              {c.category ? t(`category.${c.category}`) : ts('anyCategory')}
            </span>
            <span className="ml-auto flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setDraft({ id: c.id, title: c.title, body: c.body, category: c.category ?? '' })
                }
              >
                {t('common.edit')}
              </Button>
              {confirming === c.id ? (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    remove.mutate(c.id);
                    setConfirming(null);
                  }}
                >
                  {ts('deleteConfirm', { title: c.title })}
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setConfirming(c.id)}>
                  {t('common.remove')}
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <form
        className="grid gap-3 rounded-md border border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error ? <Alert>{error}</Alert> : null}
        <div className="grid gap-1">
          <Label htmlFor="tpl-name">{ts('templateTitle')}</Label>
          <Input
            id="tpl-name"
            value={draft.title}
            maxLength={120}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="tpl-body">{ts('templateBody')}</Label>
          <Textarea
            id="tpl-body"
            rows={4}
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            aria-invalid={bad.length > 0}
            aria-describedby="tpl-vars"
          />
          <p id="tpl-vars" className="text-xs text-muted-foreground">
            {TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join('  ')}
            {bad.length > 0 ? ` — ✗ ${bad.join(', ')}` : ''}
          </p>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="tpl-cat">{ts('templateCategory')}</Label>
          <Select
            id="tpl-cat"
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
          >
            <option value="">{ts('anyCategory')}</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`category.${c}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex gap-2">
          <Button
            type="submit"
            disabled={draft.title.trim() === '' || draft.body.trim() === '' || bad.length > 0}
          >
            {draft.id ? t('common.save') : ts('add')}
          </Button>
          {draft.id ? (
            <Button type="button" variant="ghost" onClick={() => setDraft(EMPTY)}>
              {t('common.cancel')}
            </Button>
          ) : null}
        </div>
      </form>
    </section>
  );
};

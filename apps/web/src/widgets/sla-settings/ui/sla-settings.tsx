'use client';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { PRIORITIES, slaSettingsSchema, type Priority } from '@helpdesk/shared';
import { useSaveSla, useSla } from '@/entities/agent/api/staff';
import { isApiError } from '@/shared/api/client';
import { describeError } from '@/shared/lib/error-message';
import { useAnnounce } from '@/shared/ui/announcer';
import { Alert } from '@/shared/ui/alert';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Checkbox } from '@/shared/ui/select';

type Row = { priority: Priority; first: string; resolution: string; businessHours: boolean };

export const SlaSettings = () => {
  const t = useTranslations();
  const ts = useTranslations('staff.settings');
  const announce = useAnnounce();
  const sla = useSla();
  const save = useSaveSla();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (sla.data)
      setRows(
        [...PRIORITIES].reverse().map((p) => {
          const x = sla.data.policies.find((q) => q.priority === p);
          return {
            priority: p,
            first: String(x?.firstResponseMinutes ?? ''),
            resolution: String(x?.resolutionMinutes ?? ''),
            businessHours: x?.businessHours ?? true,
          };
        }),
      );
  }, [sla.data]);
  if (!rows) return <p role="status">{t('common.loading')}</p>;
  const patch = (i: number, p: Partial<Row>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <form
      aria-labelledby="sla-title"
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const parsed = slaSettingsSchema.safeParse({
          policies: rows.map((r) => ({
            priority: r.priority,
            firstResponseMinutes: Number(r.first),
            resolutionMinutes: Number(r.resolution),
            businessHours: r.businessHours,
          })),
        });
        if (!parsed.success) return setError(t('validation.invalid'));
        try {
          await save.mutateAsync(parsed.data.policies);
          announce(ts('saved'));
        } catch (err) {
          setError(
            isApiError(err)
              ? describeError((k, v) => t(`errors.${k}`, v), err.info)
              : t('errors.unknown'),
          );
        }
      }}
    >
      <h2 id="sla-title" className="text-xl font-semibold">
        {ts('sla')}
      </h2>
      <p className="text-sm text-muted-foreground">{ts('slaHelp')}</p>
      {error ? <Alert>{error}</Alert> : null}
      <div className="grid gap-2">
        {rows.map((r, i) => (
          <fieldset
            key={r.priority}
            className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3"
          >
            <legend className="px-1 font-medium">{t(`priority.${r.priority}`)}</legend>
            <div className="grid gap-1">
              <Label htmlFor={`f-${r.priority}`}>{ts('firstResponse')}</Label>
              <Input
                id={`f-${r.priority}`}
                inputMode="numeric"
                value={r.first}
                onChange={(e) => patch(i, { first: e.target.value })}
                className="w-32"
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`r-${r.priority}`}>{ts('resolution')}</Label>
              <Input
                id={`r-${r.priority}`}
                inputMode="numeric"
                value={r.resolution}
                onChange={(e) => patch(i, { resolution: e.target.value })}
                className="w-32"
              />
            </div>
            <label className="inline-flex items-center gap-2 pb-2 text-sm">
              <Checkbox
                checked={r.businessHours}
                onChange={(e) => patch(i, { businessHours: e.target.checked })}
              />
              {ts('businessHours')}
            </label>
          </fieldset>
        ))}
      </div>
      <div>
        <Button type="submit" disabled={save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
};

'use client';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { useStats } from '@/entities/agent/api/staff';
import { isApiError } from '@/shared/api/client';
import { describeError } from '@/shared/lib/error-message';
import { formatDuration } from '@/shared/lib/duration';
import { Alert } from '@/shared/ui/alert';
import { Card, CardContent, CardHeader } from '@/shared/ui/card';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';

const dayStartIso = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const dayEndIso = (d: string) =>
  new Date(new Date(`${d}T00:00:00`).getTime() + 86_400_000).toISOString();
const isoDay = (ms: number) => new Date(ms).toLocaleDateString('sv-SE');

const Metric = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <Card>
    <CardHeader className="pb-2">
      <h2 className="text-sm font-medium text-muted-foreground">{label}</h2>
    </CardHeader>
    <CardContent>
      <p className="text-3xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
    </CardContent>
  </Card>
);

export const StatsDashboard = () => {
  const t = useTranslations();
  const td = useTranslations('staff.dashboard');
  const [from, setFrom] = useState(() => isoDay(Date.now() - 29 * 86_400_000));
  const [to, setTo] = useState(() => isoDay(Date.now()));
  const range = useMemo(
    () => (from && to && from <= to ? { from: dayStartIso(from), to: dayEndIso(to) } : null),
    [from, to],
  );
  const q = useStats(range?.from ?? '', range?.to ?? '');
  const s = q.data;
  const dur = (sec: number | null) => formatDuration(sec, (k, v) => td(`duration.${k}`, v));
  return (
    <section aria-labelledby="page-title" className="grid gap-5">
      <h1 id="page-title" className="text-2xl font-semibold">
        {td('title')}
      </h1>
      <form
        className="flex flex-wrap items-end gap-3"
        aria-label={td('period')}
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="st-from">{td('from')}</Label>
          <Input
            id="st-from"
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="st-to">{td('to')}</Label>
          <Input
            id="st-to"
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </form>
      {q.isError ? (
        <Alert>
          {isApiError(q.error)
            ? describeError((k, v) => t(`errors.${k}`, v), q.error.info)
            : t('errors.unknown')}
        </Alert>
      ) : null}
      {q.isPending && range ? (
        <p role="status" className="text-muted-foreground">
          {t('common.loading')}
        </p>
      ) : null}
      {s ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="metrics">
            <Metric label={td('created')} value={String(s.created)} />
            <Metric label={td('resolved')} value={String(s.resolved)} />
            <Metric label={td('avgFirst')} value={dur(s.avgFirstResponseSeconds)} />
            <Metric label={td('avgResolution')} value={dur(s.avgResolutionSeconds)} />
            <Metric
              label={td('breach')}
              value={s.slaBreachPercent === null ? '—' : `${s.slaBreachPercent}%`}
            />
            <Metric
              label={td('avgRating')}
              value={s.avgRating === null ? '—' : s.avgRating.toFixed(1)}
              hint={td('ratings', { count: s.ratingCount })}
            />
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="p-3 text-left text-base font-semibold">{td('workload')}</caption>
              <thead className="border-y border-border bg-muted">
                <tr>
                  <th scope="col" className="p-2">
                    {td('agent')}
                  </th>
                  <th scope="col" className="p-2">
                    {td('active')}
                  </th>
                  <th scope="col" className="p-2">
                    {td('resolvedPeriod')}
                  </th>
                  <th scope="col" className="p-2">
                    {td('breachedCol')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.workload.map((w) => (
                  <tr key={w.agent.id} className="border-b border-border">
                    <th scope="row" className="p-2 font-medium">
                      {w.agent.name}
                    </th>
                    <td className="p-2 tabular-nums">{w.active}</td>
                    <td className="p-2 tabular-nums">{w.resolvedInPeriod}</td>
                    <td className="p-2 tabular-nums">{w.breached}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
};

'use client';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { CATEGORIES, PRIORITIES, STATUSES } from '@helpdesk/shared';
import { debounce } from '@/shared/lib/drafts';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Checkbox, Select } from '@/shared/ui/select';
import { DEFAULT_FILTERS, type TicketFilters } from '@/entities/ticket/model/filters';

const toggle = <T extends string>(list: readonly T[], v: T): T[] =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : null);
const dayEnd = (d: string) => (d ? new Date(`${d}T23:59:59.999`).toISOString() : null);
const asDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('sv-SE') : '');

const Group = ({ legend, children }: { legend: string; children: React.ReactNode }) => (
  <fieldset className="grid gap-1.5">
    <legend className="text-sm font-medium">{legend}</legend>
    <div className="flex flex-wrap gap-x-3 gap-y-1">{children}</div>
  </fieldset>
);

export const FilterBar = ({
  filters,
  onChange,
}: {
  filters: TicketFilters;
  onChange: (next: TicketFilters, mode?: 'push' | 'replace') => void;
}) => {
  const t = useTranslations();
  const [q, setQ] = useState(filters.q);
  const latest = useRef(filters);
  latest.current = filters;
  useEffect(() => setQ(filters.q), [filters.q]); // Back/Forward and saved views change the URL: follow it
  const commitSearch = useRef(
    debounce((value: string) => onChange({ ...latest.current, q: value }, 'replace'), 300),
  );
  useEffect(() => {
    commitSearch.current = debounce(
      (value: string) => onChange({ ...latest.current, q: value }, 'replace'),
      300,
    );
  }, [onChange]);
  const set = (patch: Partial<TicketFilters>) => onChange({ ...filters, ...patch });
  const active =
    JSON.stringify({ ...filters, sort: 'created', order: 'desc' }) !==
    JSON.stringify(DEFAULT_FILTERS);

  return (
    <form
      role="search"
      aria-label={t('queue.filters.title')}
      className="grid gap-4 rounded-lg border border-border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        commitSearch.current.cancel();
        onChange({ ...filters, q }, 'replace');
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="queue-search">{t('queue.filters.search')}</Label>
        <Input
          id="queue-search"
          type="search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            commitSearch.current(e.target.value);
          }}
        />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Group legend={t('ticket.status')}>
          {STATUSES.map((s) => (
            <label key={s} className="inline-flex items-center gap-1.5 text-sm">
              <Checkbox
                checked={filters.status.includes(s)}
                onChange={() => set({ status: toggle(filters.status, s) })}
              />
              {t(`status.${s}`)}
            </label>
          ))}
        </Group>
        <Group legend={t('ticket.priority')}>
          {PRIORITIES.map((p) => (
            <label key={p} className="inline-flex items-center gap-1.5 text-sm">
              <Checkbox
                checked={filters.priority.includes(p)}
                onChange={() => set({ priority: toggle(filters.priority, p) })}
              />
              {t(`priority.${p}`)}
            </label>
          ))}
        </Group>
        <Group legend={t('ticket.category')}>
          {CATEGORIES.map((c) => (
            <label key={c} className="inline-flex items-center gap-1.5 text-sm">
              <Checkbox
                checked={filters.category.includes(c)}
                onChange={() => set({ category: toggle(filters.category, c) })}
              />
              {t(`category.${c}`)}
            </label>
          ))}
        </Group>
      </div>
      <div className="grid gap-4 md:grid-cols-4">
        <div className="grid gap-1.5">
          <Label htmlFor="f-assignee">{t('queue.filters.assignee')}</Label>
          <Select
            id="f-assignee"
            value={filters.assignee === 'me' || filters.assignee === 'none' ? filters.assignee : ''}
            onChange={(e) => set({ assignee: e.target.value === '' ? null : e.target.value })}
          >
            <option value="">{t('queue.filters.assigneeAny')}</option>
            <option value="me">{t('queue.filters.assigneeMe')}</option>
            <option value="none">{t('queue.filters.assigneeNone')}</option>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="f-sla">{t('queue.filters.slaBreached')}</Label>
          <Select
            id="f-sla"
            value={filters.slaBreached === null ? '' : String(filters.slaBreached)}
            onChange={(e) =>
              set({ slaBreached: e.target.value === '' ? null : e.target.value === 'true' })
            }
          >
            <option value="">{t('queue.filters.slaAny')}</option>
            <option value="true">{t('queue.filters.slaYes')}</option>
            <option value="false">{t('queue.filters.slaNo')}</option>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="f-tags">{t('queue.filters.tags')}</Label>
          <Input
            id="f-tags"
            defaultValue={filters.tags.join(', ')}
            key={filters.tags.join(',')}
            onBlur={(e) =>
              set({
                tags: e.target.value
                  .split(',')
                  .map((x) => x.trim().toLowerCase())
                  .filter(Boolean),
              })
            }
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="f-sort">{t('queue.filters.sort')}</Label>
          <div className="flex gap-2">
            <Select
              id="f-sort"
              value={filters.sort}
              onChange={(e) => set({ sort: e.target.value as TicketFilters['sort'] })}
            >
              <option value="created">{t('queue.filters.sortCreated')}</option>
              <option value="updated">{t('queue.filters.sortUpdated')}</option>
              <option value="sla">{t('queue.filters.sortSla')}</option>
            </Select>
            <Select
              aria-label={t('queue.filters.order')}
              value={filters.order}
              onChange={(e) => set({ order: e.target.value as 'asc' | 'desc' })}
            >
              <option value="desc">{t('queue.filters.desc')}</option>
              <option value="asc">{t('queue.filters.asc')}</option>
            </Select>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="f-from">
            {t('queue.filters.period')} — {t('common.from')}
          </Label>
          <Input
            id="f-from"
            type="date"
            value={asDay(filters.createdFrom)}
            onChange={(e) => set({ createdFrom: dayStart(e.target.value) })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="f-to">{t('common.to')}</Label>
          <Input
            id="f-to"
            type="date"
            value={asDay(filters.createdTo)}
            onChange={(e) => set({ createdTo: dayEnd(e.target.value) })}
          />
        </div>
        {active ? (
          <Button type="button" variant="ghost" onClick={() => onChange(DEFAULT_FILTERS)}>
            {t('queue.filters.clear')}
          </Button>
        ) : null}
      </div>
    </form>
  );
};

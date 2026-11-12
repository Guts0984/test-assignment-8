'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  PRIORITIES,
  STATUSES,
  type BulkResult,
  type Priority,
  type Role,
  type TicketDto,
  type TicketStatus,
} from '@helpdesk/shared';
import { useAgents } from '@/entities/agent/api/staff';
import { api } from '@/shared/api/client';
import { useBulk } from '@/entities/ticket/api/tickets';
import { isApiError } from '@/shared/api/client';
import { describeError } from '@/shared/lib/error-message';
import { useAnnounce } from '@/shared/ui/announcer';
import { Alert } from '@/shared/ui/alert';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Select } from '@/shared/ui/select';
import { chunkIds, summarize, type BulkOperation, type BulkReport } from '../model/bulk';

type Action = '' | 'assign' | 'status' | 'priority' | 'addTags' | 'removeTags';

/** Act on the selected tickets; the answer says, per ticket, what was applied and why anything was skipped. */
export const BulkBar = ({
  selected,
  tickets,
  role,
  meId,
  onApplied,
  onReport,
  onClear,
}: {
  selected: readonly string[];
  tickets: readonly TicketDto[];
  role: Role;
  meId: string;
  onApplied: (okIds: string[]) => void;
  onReport: (r: BulkReport) => void;
  onClear: () => void;
}) => {
  const t = useTranslations('queue.bulk');
  const te = useTranslations('errors');
  const tall = useTranslations();
  const announce = useAnnounce();
  const agents = useAgents();
  const bulk = useBulk();
  const [action, setAction] = useState<Action>('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  void api;

  const operation = (): BulkOperation | null => {
    if (action === 'assign') return { action: 'assign', assigneeId: value === '' ? null : value };
    if (action === 'status' && value) return { action: 'setStatus', status: value as TicketStatus };
    if (action === 'priority' && value)
      return { action: 'setPriority', priority: value as Priority };
    if ((action === 'addTags' || action === 'removeTags') && value.trim())
      return {
        action: 'setTags',
        mode: action === 'addTags' ? 'add' : 'remove',
        tags: value
          .split(',')
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean),
      };
    return null;
  };
  const op = operation();
  void tickets;

  const apply = async () => {
    if (!op || selected.length === 0) return;
    setError(null);
    try {
      const results: BulkResult['results'] = [];
      for (const ids of chunkIds(selected))
        results.push(...(await bulk.mutateAsync({ ids, operation: op })).results);
      const r = summarize(results);
      onReport(r);
      announce(t('report', { ok: r.ok.length, skipped: r.skipped.length }));
      onReport(r);
      onApplied(r.ok);
    } catch (e) {
      setError(isApiError(e) ? describeError((k, v) => te(k, v), e.info) : te('unknown'));
    }
  };

  const agentOptions = (agents.data ?? []).filter((a) => role === 'lead' || a.id === meId);
  return (
    <section
      aria-label={t('title')}
      className="grid gap-3 rounded-lg border border-primary/50 bg-accent p-3"
    >
      <div className="flex flex-wrap items-end gap-3">
        <p className="font-semibold" data-testid="selected-count">
          {tall('queue.selected', { count: selected.length })}
        </p>
        <div className="grid gap-1">
          <Label htmlFor="bulk-action">{t('chooseAction')}</Label>
          <Select
            id="bulk-action"
            value={action}
            onChange={(e) => {
              setAction(e.target.value as Action);
              setValue('');
            }}
            className="w-52"
          >
            <option value="">—</option>
            <option value="assign">{t('assign')}</option>
            <option value="status">{t('status')}</option>
            <option value="priority">{t('priority')}</option>
            <option value="addTags">{t('addTags')}</option>
            <option value="removeTags">{t('removeTags')}</option>
          </Select>
        </div>
        {action === 'assign' ? (
          <div className="grid gap-1">
            <Label htmlFor="bulk-value">{tall('ticket.assignee')}</Label>
            <Select
              id="bulk-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-52"
            >
              <option value="">{tall('ticket.unassigned')}</option>
              {agentOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {action === 'status' ? (
          <div className="grid gap-1">
            <Label htmlFor="bulk-value">{tall('ticket.status')}</Label>
            <Select
              id="bulk-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-52"
            >
              <option value="">{t('chooseValue')}</option>
              {STATUSES.filter((s) => s !== 'new').map((s) => (
                <option key={s} value={s}>
                  {tall(`status.${s}`)}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {action === 'priority' ? (
          <div className="grid gap-1">
            <Label htmlFor="bulk-value">{tall('ticket.priority')}</Label>
            <Select
              id="bulk-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-52"
            >
              <option value="">{t('chooseValue')}</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {tall(`priority.${p}`)}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {action === 'addTags' || action === 'removeTags' ? (
          <div className="grid gap-1">
            <Label htmlFor="bulk-value">{t('tags')}</Label>
            <Input
              id="bulk-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-52"
            />
          </div>
        ) : null}
        <Button
          onClick={() => void apply()}
          disabled={!op || bulk.isPending}
          aria-busy={bulk.isPending}
        >
          {bulk.isPending ? t('running') : t('apply')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            onClear();
          }}
        >
          {t('clearSelection')}
        </Button>
      </div>
      {error ? <Alert>{error}</Alert> : null}
    </section>
  );
};

'use client';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import {
  CATEGORIES,
  PRIORITIES,
  allowedTransitions,
  type AgentDto,
  type Role,
  type TicketDto,
} from '@helpdesk/shared';
import { usePatchTicket } from '@/entities/ticket/api/tickets';
import { StatusBadge } from '@/entities/ticket/ui/badges';
import { isApiError } from '@/shared/api/client';
import { countdown } from '@/shared/lib/countdown';
import { describeError } from '@/shared/lib/error-message';
import { useNow } from '@/shared/lib/use-now';
import { useAnnounce } from '@/shared/ui/announcer';
import { Alert } from '@/shared/ui/alert';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { LocalTime } from '@/shared/ui/local-time';
import { Select } from '@/shared/ui/select';
import {
  diffForm,
  planPatch,
  rebaseForm,
  remoteChanges,
  toForm,
  type FieldKey,
  type SidebarForm,
} from '../model/sidebar-model';

export const SlaCountdown = ({ dueAt }: { dueAt: string }) => {
  const t = useTranslations('queue.sla');
  const now = useNow();
  if (now === 0) return <span>{' '}</span>;
  const c = countdown(dueAt, now);
  const text =
    c.days > 0
      ? t('dhm', { days: c.days, hours: c.hours, mins: c.mins })
      : c.hours > 0
        ? t('hm', { hours: c.hours, mins: c.mins })
        : t('m', { mins: c.mins });
  return (
    <span
      className={
        c.overdue
          ? 'font-semibold text-destructive'
          : c.soon
            ? 'font-semibold text-amber-800 dark:text-amber-300'
            : ''
      }
    >
      {c.overdue ? t('overdue', { text }) : t('left', { text })}
    </span>
  );
};

const FIELD_LABEL: Record<FieldKey, string> = {
  status: 'ticket.status',
  priority: 'ticket.priority',
  category: 'ticket.category',
  assigneeId: 'ticket.assignee',
  tags: 'ticket.tags',
};

/**
 * Status / priority / category / assignee / tags + SLA. Saving sends the version the form was started from; if someone
 * else changed the ticket meanwhile (409, or a live update), the user sees WHAT changed and keeps everything they typed.
 */
export const TicketSidebar = ({
  ticket,
  role,
  meId,
  agents,
}: {
  ticket: TicketDto;
  role: Role;
  meId: string;
  agents: readonly AgentDto[];
}) => {
  const t = useTranslations();
  const announce = useAnnounce();
  const patch = usePatchTicket(ticket.id);
  const [base, setBase] = useState(ticket);
  const [form, setForm] = useState<SidebarForm>(toForm(ticket));
  const [conflict, setConflict] = useState<TicketDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = diffForm(base, form).length > 0;
  // what the server has right now, as far as we know: the newer of the live ticket and a 409's "current"
  const latest = conflict && conflict.version >= ticket.version ? conflict : ticket;
  const drift = latest.version > base.version ? remoteChanges(base, latest) : [];
  // "your edit" is shown only for fields the user really changed; values are shown the way the screen speaks, not raw
  const mine = new Set(diffForm(base, form));
  const show = (f: FieldKey, v: SidebarForm[FieldKey], cur: TicketDto): string => {
    if (v === null || v === '') return f === 'assigneeId' ? t('ticket.unassigned') : '—';
    switch (f) {
      case 'status':
        return t(`status.${v}`);
      case 'priority':
        return t(`priority.${v}`);
      case 'category':
        return t(`category.${v}`);
      case 'assigneeId':
        return (
          agents.find((a) => a.id === v)?.name ??
          (cur.assignee?.id === v ? cur.assignee.name : undefined) ??
          (ticket.assignee?.id === v ? ticket.assignee.name : String(v))
        );
      default:
        return String(v);
    }
  };

  // a live update arrives: with no local edits just follow it; with edits, keep the form and show the drift
  useEffect(() => {
    if (ticket.version <= base.version) return; // only follow NEWER server state (we may already hold a newer one from a 409)
    if (!dirty) {
      setBase(ticket);
      setForm(toForm(ticket));
      setConflict(null);
    }
  }, [ticket, base.version, dirty]);

  const set = <K extends keyof SidebarForm>(k: K, v: SidebarForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const body = planPatch(base, form);
    if (!body) return;
    setError(null);
    try {
      const saved = await patch.mutateAsync(body);
      setBase(saved);
      setForm(toForm(saved));
      setConflict(null);
      announce(t('staff.sidebar.saved'));
    } catch (e) {
      if (isApiError(e) && e.info.code === 'version_conflict' && e.info.current) {
        setConflict(e.info.current as TicketDto); // the user's edits stay in the form
        return;
      }
      setError(
        isApiError(e) ? describeError((k, v) => t(`errors.${k}`, v), e.info) : t('errors.unknown'),
      );
    }
  };
  /** Keep my edits, but build them on top of the current version (so the next save is accepted if nothing else changed). */
  const rebase = () => {
    const cur = latest;
    setForm((f) => rebaseForm(base, f, cur)); // my edits stay; fields I did not touch take the server's value
    setBase(cur);
    setConflict(null);
  };
  const discard = () => {
    const cur = latest;
    setBase(cur);
    setForm(toForm(cur));
    setConflict(null);
  };

  const statuses = [ticket.status, ...allowedTransitions(ticket.status, role)];
  const agentOptions =
    role === 'lead' ? agents : agents.filter((a) => a.id === meId || a.id === ticket.assignee?.id);
  const closed = ticket.status === 'closed';
  const sla = ticket.sla;

  return (
    <aside
      aria-label={t('staff.sidebar.title')}
      className="grid content-start gap-4 rounded-lg border border-border p-4"
    >
      <h2 className="text-lg font-semibold">{t('staff.sidebar.title')}</h2>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={ticket.status} />
        <span className="text-muted-foreground">v{ticket.version}</span>
      </div>

      {conflict || drift.length > 0 ? (
        <Alert data-testid="conflict" className="grid gap-2">
          <strong>{t('staff.sidebar.conflictTitle')}</strong>
          <span>{t('staff.sidebar.conflictBody')}</span>
          <ul className="list-disc pl-5">
            {drift.map((f) => (
              <li key={f}>
                {t(FIELD_LABEL[f])}: {t('staff.sidebar.current')} →{' '}
                <b>{show(f, toForm(latest)[f], latest)}</b>
                {mine.has(f) ? (
                  <>
                    ; {t('staff.sidebar.yourEdit')} → <b>{show(f, form[f], latest)}</b>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={discard}>
              {t('staff.sidebar.applyCurrent')}
            </Button>
            <Button type="button" size="sm" onClick={rebase}>
              {t('staff.sidebar.keepMine')}
            </Button>
          </div>
        </Alert>
      ) : null}
      {error ? <Alert data-testid="sidebar-error">{error}</Alert> : null}

      <div className="grid gap-1.5">
        <Label htmlFor="sb-status">{t('ticket.status')}</Label>
        <Select
          id="sb-status"
          value={form.status}
          disabled={closed}
          onChange={(e) => set('status', e.target.value as SidebarForm['status'])}
        >
          {statuses.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="sb-priority">{t('ticket.priority')}</Label>
        <Select
          id="sb-priority"
          value={form.priority}
          disabled={closed}
          onChange={(e) => set('priority', e.target.value as SidebarForm['priority'])}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {t(`priority.${p}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="sb-category">{t('ticket.category')}</Label>
        <Select
          id="sb-category"
          value={form.category}
          disabled={closed || role !== 'lead'}
          aria-describedby={role !== 'lead' ? 'sb-category-hint' : undefined}
          onChange={(e) => set('category', e.target.value as SidebarForm['category'])}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`category.${c}`)}
            </option>
          ))}
        </Select>
        {role !== 'lead' ? (
          <p id="sb-category-hint" className="text-xs text-muted-foreground">
            {t('staff.sidebar.categoryLeadOnly')}
          </p>
        ) : null}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="sb-assignee">{t('ticket.assignee')}</Label>
        <Select
          id="sb-assignee"
          value={form.assigneeId ?? ''}
          disabled={closed}
          onChange={(e) => set('assigneeId', e.target.value === '' ? null : e.target.value)}
        >
          <option value="">{t('ticket.unassigned')}</option>
          {agentOptions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
          {ticket.assignee && !agentOptions.some((a) => a.id === ticket.assignee?.id) ? (
            <option value={ticket.assignee.id}>{ticket.assignee.name}</option>
          ) : null}
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="sb-tags">{t('ticket.tags')}</Label>
        <Input
          id="sb-tags"
          value={form.tags}
          disabled={closed}
          onChange={(e) => set('tags', e.target.value)}
        />
      </div>
      <Button
        type="button"
        onClick={() => void save()}
        disabled={!dirty || patch.isPending || closed}
        aria-busy={patch.isPending}
      >
        {patch.isPending ? t('staff.sidebar.saving') : t('staff.sidebar.save')}
      </Button>

      {sla ? (
        <section
          aria-label={t('ticket.sla')}
          className="grid gap-1 border-t border-border pt-3 text-sm"
        >
          <h3 className="font-semibold">{t('ticket.sla')}</h3>
          {sla.pausedAt ? <p>{t('staff.sidebar.slaPaused')}</p> : null}
          {sla.breached ? (
            <p className="font-semibold text-destructive">{t('staff.sidebar.slaBreached')}</p>
          ) : null}
          <p>
            {t('staff.sidebar.slaFirst')}: <LocalTime value={sla.firstResponseDue} />{' '}
            {!sla.firstRespondedAt && sla.dueAt === sla.firstResponseDue ? (
              <SlaCountdown dueAt={sla.firstResponseDue} />
            ) : null}
          </p>
          {sla.firstRespondedAt ? (
            <p className="text-muted-foreground">
              {t('staff.sidebar.firstResponded')}: <LocalTime value={sla.firstRespondedAt} />
            </p>
          ) : null}
          <p>
            {t('staff.sidebar.slaResolution')}: <LocalTime value={sla.resolutionDue} />{' '}
            {sla.dueAt === sla.resolutionDue ? <SlaCountdown dueAt={sla.resolutionDue} /> : null}
          </p>
        </section>
      ) : null}
    </aside>
  );
};

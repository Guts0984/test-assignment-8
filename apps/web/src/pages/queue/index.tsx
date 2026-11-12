'use client';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMe } from '@/entities/session/api/session';
import { useTicketList } from '@/entities/ticket/api/tickets';
import { BulkBar } from '@/features/bulk-actions/ui/bulk-bar';
import { BulkReportPanel } from '@/features/bulk-actions/ui/bulk-report';
import type { BulkReport } from '@/features/bulk-actions/model/bulk';
import { HotkeyHelp } from '@/features/hotkeys/ui/hotkey-help';
import { useHotkeys } from '@/features/hotkeys/model/use-hotkeys';
import { useFiltersUrl } from '@/features/ticket-filters/model/use-filters-url';
import { FilterBar } from '@/features/ticket-filters/ui/filter-bar';
import { SavedViews } from '@/features/ticket-filters/ui/saved-views';
import { TakeNextButton } from '@/features/take-next/ui/take-next-button';
import { isApiError } from '@/shared/api/client';
import { describeError } from '@/shared/lib/error-message';
import { moveSelection } from '@/shared/lib/hotkeys';
import { Alert } from '@/shared/ui/alert';
import { Button } from '@/shared/ui/button';
import { TicketTable } from '@/widgets/ticket-table/ui/ticket-table';

/** The staff work place: filtered, live list with selection, bulk actions, "take next" and keyboard shortcuts. */
export const QueuePage = () => {
  const t = useTranslations();
  const router = useRouter();
  const me = useMe().data;
  const { filters, set } = useFiltersUrl();
  const list = useTicketList(filters, me?.id ?? '');
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState(-1);
  const [help, setHelp] = useState(false);
  const [report, setReport] = useState<BulkReport | null>(null);

  useEffect(() => {
    document.title = `${t('queue.title')} · ${t('app.name')}`;
  }, [t]);
  // keep the cursor on the same TICKET when the list changes underneath it (live updates)
  const cursorId = items[cursor]?.id;
  useEffect(() => {
    if (cursorId === undefined) return;
    const idx = items.findIndex((i) => i.id === cursorId);
    if (idx !== cursor && idx !== -1) setCursor(idx);
  }, [items, cursorId, cursor]);

  const open = useCallback((id: string) => router.push(`/tickets/${id}`), [router]);
  const toggle = useCallback(
    (id: string) =>
      setSelected((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    [],
  );
  const toggleAll = useCallback(
    (all: boolean) => setSelected(all ? new Set(items.map((i) => i.id)) : new Set()),
    [items],
  );

  useHotkeys({
    j: () => setCursor((c) => moveSelection(c, 1, items.length)),
    k: () => setCursor((c) => moveSelection(c, -1, items.length)),
    Enter: () => {
      const tk = items[cursor];
      if (tk) open(tk.id);
    },
    '/': () => document.getElementById('queue-search')?.focus(),
    '?': () => setHelp(true),
  });

  if (!me) return null;
  const chosen = items.filter((i) => selected.has(i.id));
  return (
    <section aria-labelledby="page-title" className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="page-title" className="text-2xl font-semibold">
          {t('queue.title')}
        </h1>
        <span className="text-xs text-muted-foreground" aria-hidden="true">
          {t('queue.hotkeys.hint')}
        </span>
        <div className="ml-auto flex gap-2">
          <TakeNextButton />
        </div>
      </div>
      <SavedViews
        filters={filters}
        onApply={(f) => {
          setSelected(new Set());
          set(f);
        }}
      />
      <FilterBar
        filters={filters}
        onChange={(f, mode) => {
          if (mode !== 'replace') setSelected(new Set());
          set(f, mode);
        }}
      />
      {selected.size > 0 ? (
        <BulkBar
          selected={[...selected]}
          tickets={items}
          role={me.role}
          meId={me.id}
          onApplied={(ok) => setSelected((s) => new Set([...s].filter((id) => !ok.includes(id))))}
          onReport={setReport}
          onClear={() => setSelected(new Set())}
        />
      ) : null}
      {report ? (
        <BulkReportPanel report={report} tickets={items} onDismiss={() => setReport(null)} />
      ) : null}
      {list.isError ? (
        <Alert>
          {isApiError(list.error)
            ? describeError((k, v) => t(`errors.${k}`, v), list.error.info)
            : t('errors.unknown')}
        </Alert>
      ) : null}
      {list.isPending ? (
        <p role="status" className="text-muted-foreground">
          {t('common.loading')}
        </p>
      ) : null}
      {!list.isPending && items.length === 0 ? (
        <p className="text-muted-foreground">{t('queue.empty')}</p>
      ) : null}
      {items.length > 0 ? (
        <TicketTable
          items={items}
          selected={selected}
          currentIndex={cursor}
          onToggle={toggle}
          onToggleAll={toggleAll}
          onOpen={open}
        />
      ) : null}
      <p className="sr-only" role="status">
        {t('queue.live')}
      </p>
      {list.hasNextPage ? (
        <div>
          <Button
            variant="outline"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? t('common.loadingMore') : t('common.loadMore')}
          </Button>
        </div>
      ) : null}
      <HotkeyHelp open={help} onClose={() => setHelp(false)} />
      <span hidden>{chosen.length}</span>
    </section>
  );
};

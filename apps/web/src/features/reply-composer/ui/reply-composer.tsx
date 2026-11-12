'use client';
import { Lock, Send } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { renderTemplate, type CannedResponseDto, type Role } from '@helpdesk/shared';
import { sendTyping, useCanned } from '@/entities/agent/api/staff';
import { usePostMessage } from '@/entities/ticket/api/tickets';
import { useAttachments } from '@/features/attachments-upload/model/use-attachments';
import { AttachmentPicker } from '@/features/attachments-upload/ui/attachment-picker';
import { isApiError } from '@/shared/api/client';
import { clearDraft, debounce, loadDraft, saveDraft } from '@/shared/lib/drafts';
import { describeError } from '@/shared/lib/error-message';
import { cn } from '@/shared/lib/cn';
import { useAnnounce } from '@/shared/ui/announcer';
import { Alert } from '@/shared/ui/alert';
import { Button } from '@/shared/ui/button';
import { Textarea } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Select } from '@/shared/ui/select';
import { parseReplyDraft, planSend, replyDraftKey } from '../model/draft';

export type ComposerProps = {
  ticketId: string;
  ticketCode: string;
  customerName: string;
  meId: string;
  role: Role;
  onSent?: (r: { spawnedFrom: string | null; ticketId: string }) => void;
};

export const ReplyComposer = ({
  ticketId,
  ticketCode,
  customerName,
  meId,
  role,
  onSent,
}: ComposerProps) => {
  const t = useTranslations();
  const announce = useAnnounce();
  const staff = role !== 'customer';
  const post = usePostMessage(ticketId);
  const attachments = useAttachments();
  const canned = useCanned(staff);
  const key = replyDraftKey(meId, ticketId);
  const initial = useMemo(() => loadDraft(key, parseReplyDraft), [key]);
  const [body, setBody] = useState(initial?.body ?? '');
  const [mode, setMode] = useState<'reply' | 'note'>(initial?.mode ?? 'reply');
  const [warn, setWarn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messageId = useRef(initial?.messageId ?? crypto.randomUUID()); // same id on retry = no duplicate
  const area = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);

  const persist = useRef(
    debounce(
      (v: { body: string; mode: 'reply' | 'note' }) =>
        v.body.trim() === ''
          ? clearDraft(key)
          : saveDraft(key, { ...v, messageId: messageId.current }),
      400,
    ),
  );
  useEffect(() => {
    persist.current({ body, mode });
  }, [body, mode]);
  useEffect(() => {
    const p = persist.current;
    return () => p.flush();
  }, []);

  // "Now replying: Ivan": tell colleagues while typing (refreshed every 4 s), retract on leaving
  useEffect(() => {
    if (!staff) return undefined;
    return () => void sendTyping(ticketId, false).catch(() => undefined);
  }, [staff, ticketId]);
  const typed = (next: string) => {
    setBody(next);
    if (staff && next.trim() !== '' && Date.now() - lastTyping.current > 4_000) {
      lastTyping.current = Date.now();
      void sendTyping(ticketId, true).catch(() => undefined);
    }
  };

  const insertTemplate = (tpl: CannedResponseDto) => {
    const text = renderTemplate(tpl.body, {
      customer_name: customerName,
      ticket_number: ticketCode,
    });
    const el = area.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    typed(`${body.slice(0, start)}${text}${body.slice(end)}`);
    requestAnimationFrame(() => el?.focus());
  };

  const send = async (action: 'send' | 'wait' | 'resolve') => {
    if (body.trim() === '' || post.isPending || attachments.uploading) return;
    setError(null);
    try {
      const plan = planSend(mode, action);
      const res = await post.mutateAsync({
        id: messageId.current,
        body,
        kind: plan.kind,
        attachmentIds: attachments.ids,
        ...(plan.setStatus ? { setStatus: plan.setStatus } : {}),
      });
      persist.current.cancel();
      clearDraft(key);
      messageId.current = crypto.randomUUID();
      setBody('');
      setWarn(false);
      attachments.clear();
      if (staff) void sendTyping(ticketId, false).catch(() => undefined);
      announce(
        res.spawnedFrom
          ? t('ticket.detail.spawned', { code: res.ticket.code })
          : t('ticket.reply.sent'),
      );
      onSent?.({ spawnedFrom: res.spawnedFrom, ticketId: res.ticket.id });
    } catch (e) {
      setError(
        isApiError(e) ? describeError((k, v) => t(`errors.${k}`, v), e.info) : t('errors.unknown'),
      );
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send('send');
    }
  };

  const note = mode === 'note';
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send('send');
      }}
      className={cn(
        'grid gap-3 rounded-lg border-2 p-3',
        note ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30' : 'border-border',
      )}
      data-mode={mode}
      aria-label={t(staff ? 'staff.composer.modeLabel' : 'ticket.reply.label')}
    >
      {staff ? (
        <fieldset className="flex flex-wrap items-center gap-4">
          <legend className="sr-only">{t('staff.composer.modeLabel')}</legend>
          {(['reply', 'note'] as const).map((m) => (
            <label key={m} className="inline-flex items-center gap-2 text-sm font-medium">
              <input
                type="radio"
                name={`mode-${ticketId}`}
                checked={mode === m}
                onChange={() => {
                  setMode(m);
                  setWarn(m === 'reply' && mode === 'note' && body.trim() !== ''); // text written as a note is about to become visible
                }}
              />
              {m === 'note' ? <Lock className="size-3.5" aria-hidden="true" /> : null}
              {t(m === 'reply' ? 'staff.composer.modeReply' : 'staff.composer.modeNote')}
            </label>
          ))}
          <span
            className={cn(
              'text-sm',
              note ? 'font-semibold text-amber-900 dark:text-amber-200' : 'text-muted-foreground',
            )}
            data-testid="visibility-hint"
          >
            {t(note ? 'staff.composer.noteHint' : 'staff.composer.replyHint')}
          </span>
        </fieldset>
      ) : null}
      {warn ? (
        <p
          role="status"
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
        >
          {t('staff.composer.confirmNoteToReply')}
        </p>
      ) : null}
      {error ? <Alert data-testid="send-error">{error}</Alert> : null}
      <div className="grid gap-2">
        <Label htmlFor={`body-${ticketId}`}>
          {t(
            staff
              ? note
                ? 'staff.composer.modeNote'
                : 'staff.composer.modeReply'
              : 'ticket.reply.label',
          )}
        </Label>
        <Textarea
          id={`body-${ticketId}`}
          ref={area}
          value={body}
          onChange={(e) => typed(e.target.value)}
          onKeyDown={onKeyDown}
          rows={5}
          placeholder={t(
            staff
              ? note
                ? 'staff.composer.placeholderNote'
                : 'staff.composer.placeholderReply'
              : 'ticket.reply.placeholder',
          )}
          aria-describedby={`hint-${ticketId}`}
        />
        <p id={`hint-${ticketId}`} className="text-xs text-muted-foreground">
          {t('staff.composer.shortcut')}
        </p>
      </div>
      <AttachmentPicker state={attachments} label={t('ticket.new.attachments')} />
      <div className="flex flex-wrap items-center gap-2">
        {staff && !note ? (
          <div className="flex items-center gap-2">
            <Label htmlFor={`tpl-${ticketId}`} className="sr-only">
              {t('staff.composer.templates')}
            </Label>
            <Select
              id={`tpl-${ticketId}`}
              className="w-48"
              value=""
              onChange={(e) => {
                const tpl = canned.data?.find((c) => c.id === e.target.value);
                if (tpl) insertTemplate(tpl);
              }}
              disabled={!canned.data?.length}
            >
              <option value="">
                {canned.data?.length
                  ? t('staff.composer.insertTemplate')
                  : t('staff.composer.noTemplates')}
              </option>
              {canned.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-2">
          {staff && !note ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={post.isPending || attachments.uploading || body.trim() === ''}
                onClick={() => void send('wait')}
              >
                {t('staff.composer.sendAndWait')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={post.isPending || attachments.uploading || body.trim() === ''}
                onClick={() => void send('resolve')}
              >
                {t('staff.composer.sendAndResolve')}
              </Button>
            </>
          ) : null}
          <Button
            type="submit"
            disabled={post.isPending || attachments.uploading || body.trim() === ''}
            aria-busy={post.isPending}
          >
            <Send aria-hidden="true" />
            {post.isPending
              ? t('ticket.reply.sending')
              : t(note ? 'staff.composer.sendNote' : 'ticket.reply.send')}
          </Button>
        </div>
      </div>
    </form>
  );
};

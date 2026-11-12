'use client';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { CATEGORIES, CUSTOMER_PRIORITIES, createTicketSchema } from '@helpdesk/shared';
import { useCreateTicket } from '@/entities/ticket/api/tickets';
import { useAttachments } from '@/features/attachments-upload/model/use-attachments';
import { AttachmentPicker } from '@/features/attachments-upload/ui/attachment-picker';
import { isApiError } from '@/shared/api/client';
import { clearDraft, debounce, loadDraft, saveDraft } from '@/shared/lib/drafts';
import { describeError } from '@/shared/lib/error-message';
import { zodFormResolver } from '@/shared/lib/form-resolver';
import { useAnnounce } from '@/shared/ui/announcer';
import { Alert } from '@/shared/ui/alert';
import { Button } from '@/shared/ui/button';
import { FormField } from '@/shared/ui/form-field';
import { Input, Textarea } from '@/shared/ui/input';
import { Select } from '@/shared/ui/select';
import { draftKey, parseNewTicketDraft, type NewTicketDraft } from '../model/draft';

const fields = createTicketSchema.pick({
  subject: true,
  category: true,
  priority: true,
  body: true,
});
type Values = {
  subject: string;
  category: NewTicketDraft['category'];
  priority: NewTicketDraft['priority'];
  body: string;
};

export const CreateTicketForm = ({ userId }: { userId: string }) => {
  const t = useTranslations();
  const router = useRouter();
  const announce = useAnnounce();
  const create = useCreateTicket();
  const attachments = useAttachments();
  const key = draftKey(userId);
  // loaded once: the restored draft AND its idempotency id (a retry after a lost response must not create a duplicate)
  const initial = useMemo(() => loadDraft(key, parseNewTicketDraft), [key]);
  const clientMessageId = useRef(initial?.clientMessageId ?? crypto.randomUUID());
  const [serverError, setServerError] = useState<string | null>(null);
  const [restored] = useState(initial !== null);

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodFormResolver(fields) as never,
    defaultValues: {
      subject: initial?.subject ?? '',
      category: initial?.category ?? 'other',
      priority: initial?.priority ?? 'normal',
      body: initial?.body ?? '',
    },
  });
  const watched = useWatch({ control });
  const save = useRef(
    debounce(
      (v: Partial<Values>) => saveDraft(key, { ...v, clientMessageId: clientMessageId.current }),
      400,
    ),
  );
  useEffect(() => {
    save.current(watched as Partial<Values>);
  }, [watched]);
  useEffect(() => {
    const s = save.current;
    return () => s.flush();
  }, []); // never lose the last keystrokes on navigation

  const submit = handleSubmit(async (values) => {
    setServerError(null);
    try {
      const ticket = await create.mutateAsync({
        ...values,
        attachmentIds: attachments.ids,
        clientMessageId: clientMessageId.current,
      } as never);
      save.current.cancel();
      clearDraft(key);
      announce(t('ticket.new.created', { code: ticket.code }));
      router.push(`/tickets/${ticket.id}`);
    } catch (e) {
      setServerError(
        isApiError(e) ? describeError((k, v) => t(`errors.${k}`, v), e.info) : t('errors.unknown'),
      );
    }
  });

  return (
    <form onSubmit={submit} noValidate className="grid max-w-2xl gap-4">
      {restored ? (
        <p role="status" className="flex items-center gap-3 rounded-md bg-accent px-3 py-2 text-sm">
          {t('ticket.new.draftRestored')}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              clearDraft(key);
              save.current.cancel();
              reset({ subject: '', category: 'other', priority: 'normal', body: '' });
              attachments.clear();
              clientMessageId.current = crypto.randomUUID();
            }}
          >
            {t('ticket.new.clearDraft')}
          </Button>
        </p>
      ) : null}
      {serverError ? <Alert data-testid="create-error">{serverError}</Alert> : null}
      <FormField id="subject" label={t('ticket.new.subject')} error={errors.subject}>
        {(a) => <Input {...a} maxLength={200} {...register('subject')} />}
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="category" label={t('ticket.category')} error={errors.category}>
          {(a) => (
            <Select {...a} {...register('category')}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`category.${c}`)}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField id="priority" label={t('ticket.priority')} error={errors.priority}>
          {(a) => (
            <Select {...a} {...register('priority')}>
              {CUSTOMER_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`priority.${p}`)}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </div>
      <FormField id="body" label={t('ticket.new.description')} error={errors.body}>
        {(a) => <Textarea {...a} rows={7} {...register('body')} />}
      </FormField>
      <AttachmentPicker state={attachments} label={t('ticket.new.attachments')} />
      <div>
        <Button
          type="submit"
          disabled={isSubmitting || attachments.uploading}
          aria-busy={isSubmitting}
        >
          {isSubmitting ? t('ticket.new.submitting') : t('ticket.new.submit')}
        </Button>
      </div>
    </form>
  );
};

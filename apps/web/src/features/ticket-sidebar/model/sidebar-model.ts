import type {
  Category,
  PatchTicketInput,
  Priority,
  TicketDto,
  TicketStatus,
} from '@helpdesk/shared';

export type SidebarForm = {
  status: TicketStatus;
  priority: Priority;
  category: Category;
  assigneeId: string | null;
  tags: string;
};

export const toForm = (t: TicketDto): SidebarForm => ({
  status: t.status,
  priority: t.priority,
  category: t.category,
  assigneeId: t.assignee?.id ?? null,
  tags: t.tags.join(', '),
});

export const parseTags = (raw: string): string[] =>
  [
    ...new Set(
      raw
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter((x) => x.length > 0 && x.length <= 40),
    ),
  ].slice(0, 20);

const sameTags = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && new Set([...a, ...b]).size === a.length;

export type FieldKey = keyof SidebarForm;

/** Which fields differ between what the user has in the form and a ticket. */
export const diffForm = (base: TicketDto, form: SidebarForm): FieldKey[] => {
  const out: FieldKey[] = [];
  if (form.status !== base.status) out.push('status');
  if (form.priority !== base.priority) out.push('priority');
  if (form.category !== base.category) out.push('category');
  if (form.assigneeId !== (base.assignee?.id ?? null)) out.push('assigneeId');
  if (!sameTags(parseTags(form.tags), base.tags)) out.push('tags');
  return out;
};

/** The PATCH body for saving `form` on top of `base` (only what actually changed) at `base.version`. Null = nothing to save. */
export const planPatch = (base: TicketDto, form: SidebarForm): PatchTicketInput | null => {
  const changed = diffForm(base, form);
  if (changed.length === 0) return null;
  return {
    version: base.version,
    ...(changed.includes('status') ? { status: form.status } : {}),
    ...(changed.includes('priority') ? { priority: form.priority } : {}),
    ...(changed.includes('category') ? { category: form.category } : {}),
    ...(changed.includes('assigneeId') ? { assigneeId: form.assigneeId } : {}),
    ...(changed.includes('tags') ? { tags: parseTags(form.tags) } : {}),
  };
};

/** Fields somebody ELSE changed between the version the user started from and the current one. */
export const remoteChanges = (base: TicketDto, current: TicketDto): FieldKey[] =>
  diffForm(base, toForm(current));

/**
 * Keep the user's OWN edits but build them on the current server state: a field the user did not touch adopts the
 * current value (so somebody else's change is never overwritten by a stale form value); a field they changed keeps
 * their value.
 */
export const rebaseForm = (
  oldBase: TicketDto,
  form: SidebarForm,
  current: TicketDto,
): SidebarForm => {
  const before = toForm(oldBase);
  const now = toForm(current);
  const touched = new Set(diffForm(oldBase, form));
  return {
    status: touched.has('status') ? form.status : now.status,
    priority: touched.has('priority') ? form.priority : now.priority,
    category: touched.has('category') ? form.category : now.category,
    assigneeId: touched.has('assigneeId') ? form.assigneeId : now.assigneeId,
    tags: touched.has('tags') ? form.tags : before.tags === form.tags ? now.tags : form.tags,
  };
};

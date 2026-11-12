'use client';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  BulkRequest,
  BulkResult,
  CreateMessageInput,
  CreateTicketInput,
  MessageResult,
  PatchTicketInput,
  RatingInput,
  TicketDetail,
  TicketDto,
  TicketList,
} from '@helpdesk/shared';
import { api } from '@/shared/api/client';
import { DEFAULT_FILTERS, toApiQuery, type TicketFilters } from '@/entities/ticket/model/filters';
import type { TicketPages } from '../model/pages';

export const ticketKeys = {
  all: ['tickets'] as const,
  lists: ['tickets', 'list'] as const,
  list: (filters: TicketFilters, meId: string) => ['tickets', 'list', { filters, meId }] as const,
  detail: (id: string) => ['tickets', 'detail', id] as const,
};

export const useTicketList = (filters: TicketFilters, meId: string) =>
  useInfiniteQuery({
    queryKey: ticketKeys.list(filters, meId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get<TicketList>('/tickets', {
        query: { ...toApiQuery(filters), limit: 50, cursor: pageParam },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const useTicketDetail = (id: string) =>
  useQuery({
    queryKey: ticketKeys.detail(id),
    queryFn: ({ signal }) => api.get<TicketDetail>(`/tickets/${id}`, { signal }),
  });

export const fetchTicketDetail = (id: string) => api.get<TicketDetail>(`/tickets/${id}`);

export const useCreateTicket = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: CreateTicketInput) => api.post<TicketDto>('/tickets', b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ticketKeys.lists }),
  });
};

export const usePatchTicket = (id: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: PatchTicketInput) => api.patch<TicketDto>(`/tickets/${id}`, b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ticketKeys.detail(id) }),
  });
};

export const usePostMessage = (id: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: CreateMessageInput) => api.post<MessageResult>(`/tickets/${id}/messages`, b),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ticketKeys.detail(id) });
      void qc.invalidateQueries({ queryKey: ticketKeys.lists });
    },
  });
};

export const useMarkRead = (id: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>(`/tickets/${id}/read`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ticketKeys.lists }),
  });
};

export const useRateTicket = (id: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: RatingInput) =>
      api.post<{ score: number; comment: string | null }>(`/tickets/${id}/rating`, b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ticketKeys.detail(id) }),
  });
};

export const useTakeNext = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<TicketDto>('/tickets/take-next'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ticketKeys.lists }),
  });
};

export const useBulk = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: BulkRequest) => api.post<BulkResult>('/tickets/bulk', b),
    onSettled: () => void qc.invalidateQueries({ queryKey: ticketKeys.lists }),
  });
};

/** Every cached list (any filters) as [key, data] — used to patch live updates into all of them. */
export const cachedLists = (qc: QueryClient) =>
  qc.getQueriesData<TicketPages>({ queryKey: ticketKeys.lists }) as Array<
    [readonly unknown[], TicketPages | undefined]
  >;
export const filtersOfKey = (key: readonly unknown[]): { filters: TicketFilters; meId: string } => {
  const part = key[2] as { filters?: TicketFilters; meId?: string } | undefined;
  return { filters: part?.filters ?? DEFAULT_FILTERS, meId: part?.meId ?? '' };
};

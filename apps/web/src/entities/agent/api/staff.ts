'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentDto,
  CannedResponseDto,
  CannedResponseInput,
  NotificationList,
  SlaPolicyInput,
  Stats,
} from '@helpdesk/shared';
import { api } from '@/shared/api/client';

export const useAgents = () =>
  useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<AgentDto[]>('/agents'),
    staleTime: 5 * 60_000,
  });

export const useCanned = (enabled = true) =>
  useQuery({
    queryKey: ['canned'],
    queryFn: () => api.get<CannedResponseDto[]>('/canned-responses'),
    enabled,
  });
export const useCannedMutations = () => {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ['canned'] });
  return {
    create: useMutation({
      mutationFn: (b: CannedResponseInput) => api.post<CannedResponseDto>('/canned-responses', b),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; body: CannedResponseInput }) =>
        api.put<CannedResponseDto>(`/canned-responses/${v.id}`, v.body),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.delete<void>(`/canned-responses/${id}`),
      onSuccess: done,
    }),
  };
};

export type SavedView = { id: string; name: string; query: Record<string, unknown> };
export const useSavedViews = () =>
  useQuery({ queryKey: ['saved-views'], queryFn: () => api.get<SavedView[]>('/saved-views') });
export const useSavedViewMutations = () => {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ['saved-views'] });
  return {
    create: useMutation({
      mutationFn: (v: { name: string; query: Record<string, unknown> }) =>
        api.post<SavedView>('/saved-views', v),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.delete<void>(`/saved-views/${id}`),
      onSuccess: done,
    }),
  };
};

export const useSla = () =>
  useQuery({ queryKey: ['sla'], queryFn: () => api.get<{ policies: SlaPolicyInput[] }>('/sla') });
export const useSaveSla = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (policies: SlaPolicyInput[]) =>
      api.put<{ policies: SlaPolicyInput[] }>('/sla', { policies }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sla'] }),
  });
};

export const useStats = (from: string, to: string) =>
  useQuery({
    queryKey: ['stats', from, to],
    queryFn: () => api.get<Stats>('/stats', { query: { from, to } }),
  });

export const notificationKeys = { list: ['notifications'] as const };
export const useNotifications = () =>
  useQuery({
    queryKey: notificationKeys.list,
    queryFn: () => api.get<NotificationList>('/notifications'),
    refetchOnWindowFocus: true,
  });
export const useMarkNotificationsRead = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.post<{ marked: number }>('/notifications/read', { ids }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: notificationKeys.list }),
  });
};

export const usePresence = (ticketId: string) =>
  useQuery({
    queryKey: ['presence', ticketId],
    queryFn: () => api.get<Array<{ id: string; name: string }>>(`/tickets/${ticketId}/presence`),
    staleTime: 0,
    refetchInterval: 6_000,
  });
export const sendTyping = (ticketId: string, typing: boolean) =>
  api.post<void>(`/tickets/${ticketId}/typing`, { typing });

'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginInput, Me } from '@helpdesk/shared';
import { api, isApiError } from '@/shared/api/client';

export const sessionKeys = { me: ['me'] as const };

/** The current user, or `null` when nobody is signed in (a 401 is an answer here, not an error). */
export const fetchMe = async (): Promise<Me | null> => {
  try {
    return await api.get<Me>('/me');
  } catch (e) {
    if (isApiError(e) && e.info.status === 401) return null;
    throw e;
  }
};

export const useMe = () =>
  useQuery({ queryKey: sessionKeys.me, queryFn: fetchMe, staleTime: 60_000, retry: false });

export const useLogin = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginInput) => api.post<{ user: Me }>('/auth/login', body),
    onSuccess: ({ user }) => {
      qc.setQueryData(sessionKeys.me, user);
    },
  });
};

export const useLogout = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/auth/logout'),
    onSettled: () => {
      qc.setQueryData(sessionKeys.me, null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' }); // nothing of the previous user may stay cached
    },
  });
};

export const homePathFor = (role: Me['role']): string =>
  role === 'customer' ? '/tickets' : '/queue';

import type { ReactNode } from 'react';
import { AppShell } from '@/widgets/app-shell/ui/app-shell';

export default function AuthenticatedLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

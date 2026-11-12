import * as React from 'react';
import { cn } from '@/shared/lib/cn';

/** `role="alert"` makes screen readers announce it the moment it appears (e.g. a failed login). */
export const Alert = ({
  className,
  role = 'alert',
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    role={role}
    className={cn(
      'rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive',
      className,
    )}
    {...props}
  />
);

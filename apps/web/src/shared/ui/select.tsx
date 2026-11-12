import * as React from 'react';
import { cn } from '@/shared/lib/cn';

/** A native <select>: keyboard, screen reader and mobile support for free. */
export const Select = ({ className, ...props }: React.ComponentProps<'select'>) => (
  <select
    className={cn(
      'h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 aria-[invalid=true]:border-destructive',
      className,
    )}
    {...props}
  />
);

export const Checkbox = ({
  className,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>) => (
  <input
    type="checkbox"
    className={cn(
      'size-4 rounded border-input accent-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      className,
    )}
    {...props}
  />
);

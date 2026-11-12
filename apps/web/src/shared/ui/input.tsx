import * as React from 'react';
import { cn } from '@/shared/lib/cn';

const base =
  'flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-destructive';

export const Input = ({ className, type = 'text', ...props }: React.ComponentProps<'input'>) => (
  <input type={type} className={cn(base, 'h-10', className)} {...props} />
);

export const Textarea = ({ className, ...props }: React.ComponentProps<'textarea'>) => (
  <textarea className={cn(base, 'min-h-24', className)} {...props} />
);

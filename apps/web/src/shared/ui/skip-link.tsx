import { cn } from '@/shared/lib/cn';

/** First focusable element on every page: lets keyboard users jump past the header. */
export const SkipLink = ({ label, targetId = 'main' }: { label: string; targetId?: string }) => (
  <a
    href={`#${targetId}`}
    className={cn(
      'sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground focus:outline-none focus:ring-2 focus:ring-ring',
    )}
  >
    {label}
  </a>
);

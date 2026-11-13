'use client';
import { useEffect } from 'react';

/**
 * Runs `flush` when the page is about to go away: unmount (client navigation) AND reload / tab close / app switch
 * (`pagehide`, `visibilitychange`). A debounced draft save would otherwise lose the last keystrokes.
 */
export const useFlushOnHide = (d: { flush: () => void }): void => {
  useEffect(() => {
    const onHide = () => d.flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') d.flush();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      d.flush();
    };
  }, [d]);
};

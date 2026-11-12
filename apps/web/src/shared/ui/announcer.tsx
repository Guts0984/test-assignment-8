'use client';
import * as React from 'react';

type Announce = (message: string, politeness?: 'polite' | 'assertive') => void;
const AnnouncerContext = React.createContext<Announce>(() => undefined);

/**
 * One persistent live region for the whole app. `useAnnounce()('New message…')` makes screen readers speak it
 * without moving focus. The text is cleared and re-set so that repeating the same message is announced again.
 */
export const AnnouncerProvider = ({ children }: { children: React.ReactNode }) => {
  const [polite, setPolite] = React.useState('');
  const [assertive, setAssertive] = React.useState('');
  const announce = React.useCallback<Announce>((message, politeness = 'polite') => {
    const set = politeness === 'assertive' ? setAssertive : setPolite;
    set('');
    window.setTimeout(() => set(message), 30);
  }, []);
  return (
    <AnnouncerContext.Provider value={announce}>
      {children}
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="live-polite">
        {polite}
      </div>
      <div
        className="sr-only"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        data-testid="live-assertive"
      >
        {assertive}
      </div>
    </AnnouncerContext.Provider>
  );
};

export const useAnnounce = (): Announce => React.useContext(AnnouncerContext);

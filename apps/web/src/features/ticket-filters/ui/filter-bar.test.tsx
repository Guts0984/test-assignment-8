import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { DEFAULT_FILTERS } from '@/entities/ticket/model/filters';
import { MESSAGES, renderApp } from '../../../../test/utils';
import { FilterBar } from './filter-bar';

afterEach(() => vi.useRealTimers());

describe('FilterBar search debounce', () => {
  const label = MESSAGES.en.queue.filters.search;

  it('commits the typed search to the URL after the pause', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    renderApp(<FilterBar filters={DEFAULT_FILTERS} onChange={onChange} />, { locale: 'en' });
    fireEvent.change(screen.getByLabelText(label), { target: { value: 'refund' } });
    expect(onChange).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(400));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ q: 'refund' }), 'replace');
  });

  it('a pending search NEVER navigates after the queue is gone (the agent already opened a ticket: the old timer must not drag them back to /queue)', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { unmount } = renderApp(<FilterBar filters={DEFAULT_FILTERS} onChange={onChange} />, {
      locale: 'en',
    });
    fireEvent.change(screen.getByLabelText(label), { target: { value: 'E2E pay' } });
    unmount();
    act(() => void vi.advanceTimersByTime(2_000));
    expect(onChange).not.toHaveBeenCalled();
  });
});

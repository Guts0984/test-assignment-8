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

  it('a parent re-render (live update, refetch) while the search is pending neither drops nor delays it', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { rerender } = renderApp(
      <FilterBar filters={DEFAULT_FILTERS} onChange={() => onChange(1)} />,
      {
        locale: 'en',
      },
    );
    fireEvent.change(screen.getByLabelText(label), { target: { value: 'refund' } });
    act(() => void vi.advanceTimersByTime(200));
    // the parent re-renders with a NEW inline onChange, as the queue page does on every live update
    rerender(<FilterBar filters={DEFAULT_FILTERS} onChange={() => onChange(2)} />);
    act(() => void vi.advanceTimersByTime(150));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(2); // fired once, at the original time, with the latest handler
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

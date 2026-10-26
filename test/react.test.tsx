// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memorySession } from '../src';
import {
  EventKitProvider,
  useCheckpoints,
  useEvent,
  useEventKit,
  useEventMutation,
  useFeatures,
  useFields,
  useLeaderboard,
  useMyRegistration,
  useMyTeam,
  useNotifications,
  useOnlineStatus,
  usePolls,
  useScanner,
  useSession,
  useTeamInvites,
  useTeamRules,
} from '../src/react';
import { apiError, client, EVENT } from './mock';

afterEach(() => vi.useRealTimers());

function wrap(ek: ReturnType<typeof client>['ek']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <EventKitProvider client={ek}>{children}</EventKitProvider>
    </QueryClientProvider>
  );
}

describe('react', () => {
  it('needs the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useEventKit())).toThrow('EventKitProvider');
  });

  it('tracks the session', async () => {
    const { ek } = client({ session: memorySession('t') });
    const { result } = renderHook(() => useSession(), { wrapper: wrap(ek) });
    expect(result.current).toEqual({ isSignedIn: true, token: 't' });
    act(() => ek.auth.logout());
    expect(result.current.isSignedIn).toBe(false);
  });

  it('read hooks load event data under one key per event', async () => {
    const { ek, mock } = client();
    mock.on('GET /v1/events/:id', () => ({ event: { id: EVENT }, role: 'admin' }));
    const w = wrap(ek);
    const hooks = [
      useEvent,
      useFeatures,
      useMyTeam,
      useMyRegistration,
      useFields,
      useTeamRules,
      usePolls,
      useCheckpoints,
      useLeaderboard,
      useNotifications,
    ];
    for (const hook of hooks) {
      const { result } = renderHook(() => hook(), { wrapper: w });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    }
    const { result } = renderHook(() => useTeamInvites(), { wrapper: w });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const { result: other } = renderHook(
      () => useNotifications({ eventId: 'other', refetchIntervalMs: 1000 }),
      { wrapper: w },
    );
    await waitFor(() => expect(other.current.isSuccess).toBe(true));
    expect(mock.calls.some((c) => c.path === '/v1/events/other/notifications')).toBe(true);
  });

  it("mutations refresh the event's queries", async () => {
    const { ek, mock } = client();
    let polls = 0;
    mock.on('GET /v1/events/:id/polls', () => {
      polls++;
      return [];
    });
    const w = wrap(ek);
    const { result: list } = renderHook(() => usePolls(), { wrapper: w });
    await waitFor(() => expect(list.current.isSuccess).toBe(true));
    const { result } = renderHook(
      () => useEventMutation((e, optionId: string) => e.polls.vote('p', optionId)),
      { wrapper: w },
    );
    await act(() => result.current.mutateAsync('o1'));
    await waitFor(() => expect(polls).toBe(2));
    expect(mock.calls.find((c) => c.method === 'PUT')!.body).toEqual({ optionId: 'o1' });
  });

  it('useScanner builds a scanner for the checkpoint and follows its online state', async () => {
    const { ek, mock } = client();
    let up = true;
    mock.on('GET /health', () => (up ? { status: 'ok' } : apiError(503, 'DOWN')));
    const { result, rerender, unmount } = renderHook(
      ({ cp }) => useScanner({ checkpointId: cp, pingIntervalMs: 0 }),
      { wrapper: wrap(ek), initialProps: { cp: 'gate' } },
    );
    await waitFor(() => expect(result.current.scanner?.checkpointId).toBe('gate'));
    up = false;
    await act(() => result.current.scanner!.check());
    expect(result.current.online).toBe(false);
    rerender({ cp: 'lunch' });
    await waitFor(() => expect(result.current.scanner?.checkpointId).toBe('lunch'));
    unmount();
    const { result: withEvent } = renderHook(
      () => useScanner({ checkpointId: 'g', eventId: 'other', pingIntervalMs: 0 }),
      { wrapper: wrap(ek) },
    );
    await waitFor(() => expect(withEvent.current.scanner).not.toBeNull());
  });

  it('useOnlineStatus pings the API', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { ek, mock } = client();
    let up = true;
    mock.on('GET /health', () => (up ? { status: 'ok' } : apiError(503, 'DOWN')));
    const { result, unmount } = renderHook(() => useOnlineStatus(1000), { wrapper: wrap(ek) });
    up = false;
    await act(() => vi.advanceTimersByTimeAsync(1100));
    await waitFor(() => expect(result.current).toBe(false));
    up = true;
    await act(() => vi.advanceTimersByTimeAsync(1100));
    await waitFor(() => expect(result.current).toBe(true));
    unmount();
  });
});

import '@testing-library/jest-dom/vitest';
import { act, render } from '@testing-library/react';
import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { PresenceState, RosterMember } from '@carrel/shared';
import type { CarrelProvider } from './CarrelProvider';
import { useCoalescedAwareness, usePresence } from './usePresence';

function PresenceHarness({
  provider,
  user,
  onMount,
}: {
  provider: CarrelProvider;
  user: PresenceState['user'];
  onMount: (methods: ReturnType<typeof usePresence>) => void;
}) {
  const presence = usePresence(provider, user);
  useEffect(() => {
    onMount(presence);
  }, [presence, onMount]);
  return null;
}

describe('usePresence', () => {
  let doc: Y.Doc;
  let awareness: awarenessProtocol.Awareness;
  let provider: CarrelProvider;
  const user = {
    id: 'user-1',
    name: 'Alice',
    color: '#E4572E',
    colorLight: '#FFFFFF',
  };

  beforeEach(() => {
    doc = new Y.Doc();
    awareness = new awarenessProtocol.Awareness(doc);
    provider = {
      doc,
      awareness,
    } as unknown as CarrelProvider;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('initializes awareness with active status', () => {
    render(<PresenceHarness provider={provider} user={user} onMount={() => undefined} />);
    const state = awareness.getLocalState() as PresenceState;
    expect(state).toBeDefined();
    expect(state.user).toEqual(user);
    expect(state.status).toBe('active');
  });

  it('transitions to typing on noteTyping() and reverts to active after 1500ms', () => {
    let api: ReturnType<typeof usePresence> | null = null;
    render(<PresenceHarness provider={provider} user={user} onMount={(m) => (api = m)} />);

    vi.useFakeTimers();
    act(() => {
      api?.noteTyping();
    });
    expect((awareness.getLocalState() as PresenceState).status).toBe('typing');

    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect((awareness.getLocalState() as PresenceState).status).toBe('typing');

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect((awareness.getLocalState() as PresenceState).status).toBe('active');
  });

  it('resets the 1500ms typing timer on repeated noteTyping() calls', () => {
    let api: ReturnType<typeof usePresence> | null = null;
    render(<PresenceHarness provider={provider} user={user} onMount={(m) => (api = m)} />);

    vi.useFakeTimers();
    act(() => {
      api?.noteTyping();
    });
    expect((awareness.getLocalState() as PresenceState).status).toBe('typing');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      api?.noteTyping();
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect((awareness.getLocalState() as PresenceState).status).toBe('typing');

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect((awareness.getLocalState() as PresenceState).status).toBe('active');
  });

  it('transitions to idle after 60s of inactivity and resets on user interaction', () => {
    render(<PresenceHarness provider={provider} user={user} onMount={() => undefined} />);
    expect((awareness.getLocalState() as PresenceState).status).toBe('active');

    vi.useFakeTimers();
    act(() => {
      window.dispatchEvent(new Event('pointermove'));
    });
    expect((awareness.getLocalState() as PresenceState).status).toBe('active');

    act(() => {
      vi.advanceTimersByTime(59000);
    });
    expect((awareness.getLocalState() as PresenceState).status).toBe('active');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect((awareness.getLocalState() as PresenceState).status).toBe('idle');

    act(() => {
      window.dispatchEvent(new Event('pointermove'));
    });
    expect((awareness.getLocalState() as PresenceState).status).toBe('active');
  });

  it('transitions to away when document is hidden, and back to active when visible', () => {
    render(<PresenceHarness provider={provider} user={user} onMount={() => undefined} />);
    expect((awareness.getLocalState() as PresenceState).status).toBe('active');

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect((awareness.getLocalState() as PresenceState).status).toBe('away');

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect((awareness.getLocalState() as PresenceState).status).toBe('active');
  });
});

function CoalescedHarness({
  provider,
  onChange,
}: {
  provider: CarrelProvider;
  onChange: (states: Record<number, PresenceState>) => void;
}) {
  const states = useCoalescedAwareness(provider);
  const ref = React.useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    ref.current(states);
  }, [states]);
  return null;
}

describe('useCoalescedAwareness and roster merge', () => {
  let doc: Y.Doc;
  let awareness: awarenessProtocol.Awareness;
  let provider: CarrelProvider;

  beforeEach(() => {
    doc = new Y.Doc();
    awareness = new awarenessProtocol.Awareness(doc);
    provider = {
      doc,
      awareness,
    } as unknown as CarrelProvider;
  });

  it('merges roster members with their awareness presence states', () => {
    const roster: RosterMember[] = [
      { id: 'u1', name: 'Alice', color: '#111', role: 'host', joinedAt: 1000, connected: true },
      { id: 'u2', name: 'Bob', color: '#222', role: 'member', joinedAt: 1001, connected: true },
    ];

    const awarenessStates: Record<number, PresenceState> = {
      1: {
        user: { id: 'u1', name: 'Alice', color: '#111', colorLight: '#FFF' },
        status: 'active',
      },
      2: {
        user: { id: 'u2', name: 'Bob', color: '#222', colorLight: '#FFF' },
        status: 'typing',
      },
    };

    const merged = roster.map((member) => {
      const presence = Object.values(awarenessStates).find((s) => s.user.id === member.id);
      return {
        ...member,
        status: presence?.status ?? 'active',
      };
    });

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ id: 'u1', name: 'Alice', status: 'active', role: 'host' });
    expect(merged[1]).toMatchObject({ id: 'u2', name: 'Bob', status: 'typing', role: 'member' });
  });

  it('coalesces multiple rapid awareness events via requestAnimationFrame', () => {
    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallback = cb;
      return 123;
    });

    let currentStates: Record<number, PresenceState> = {};
    const { unmount } = render(
      <CoalescedHarness provider={provider} onChange={(s) => (currentStates = s)} />,
    );

    expect(currentStates).toEqual({});

    act(() => {
      awareness.setLocalState({
        user: { id: 'u1', name: 'Alice', color: '#111', colorLight: '#FFF' },
        status: 'active',
      });
      awareness.setLocalState({
        user: { id: 'u1', name: 'Alice', color: '#111', colorLight: '#FFF' },
        status: 'typing',
      });
    });

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);

    act(() => {
      if (rafCallback) rafCallback(performance.now());
    });

    const states = Object.values(currentStates);
    expect(states).toHaveLength(1);
    expect(states[0].status).toBe('typing');

    unmount();
  });
});

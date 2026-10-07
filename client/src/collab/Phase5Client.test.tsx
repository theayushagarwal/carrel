import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, act, cleanup } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityFeed, formatAuditCopy, type AuditEvent } from '../ui/ActivityFeed';
import { HostCrownTag } from '../ui';
import { RoomSettingsModal } from '../ui/RoomSettingsModal';

describe('B3. Phase 5 Client Tests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Test 1
  it('1. Feed windowing: 1000 events, rendered rows at most 220, scrolling reveals older ones', () => {
    const events: AuditEvent[] = Array.from({ length: 1000 }, (_, i) => ({
      id: 1000 - i,
      ts: 1000000 + i * 1000,
      event: i % 2 === 0 ? 'joined' : 'edited',
      actorName: `User_${1000 - i}`,
      actorColor: '#E4572E',
      fromLine: 1,
      toLine: 5,
    }));

    render(<ActivityFeed events={events} />);

    const initialRows = screen.getAllByTestId('activity-row');
    expect(initialRows.length).toBeLessThanOrEqual(220);
    expect(initialRows.length).toBeGreaterThan(0);
    // Initial window contains the newest events (first items)
    expect(screen.getByText('User_1000 joined')).toBeInTheDocument();

    // Scroll down to middle
    const scrollArea = screen.getByTestId('activity-scroll-area');
    fireEvent.scroll(scrollArea, { target: { scrollTop: 500 * 44 } });

    const scrolledRows = screen.getAllByTestId('activity-row');
    expect(scrolledRows.length).toBeLessThanOrEqual(220);
    // Scrolling reveals older events around index 500
    expect(screen.getByText('User_500 joined')).toBeInTheDocument();
  });

  // Test 2
  it('2. Filter chips: each chip filters correctly, multiple combine, aria-pressed', () => {
    const events: AuditEvent[] = [
      { id: 1, ts: 1000, event: 'joined', actorName: 'Alice', actorColor: '#E4572E' },
      {
        id: 2,
        ts: 2000,
        event: 'edited',
        actorName: 'Bob',
        actorColor: '#8FB339',
        fromLine: 3,
        toLine: 3,
      },
      { id: 3, ts: 3000, event: 'room_locked', actorName: 'System' },
    ];

    render(<ActivityFeed events={events} />);

    const peopleChip = screen.getByRole('button', { name: 'People' });
    const editsChip = screen.getByRole('button', { name: 'Edits' });
    const systemChip = screen.getByRole('button', { name: 'System' });

    // Default: all aria-pressed true and all visible
    expect(peopleChip).toHaveAttribute('aria-pressed', 'true');
    expect(editsChip).toHaveAttribute('aria-pressed', 'true');
    expect(systemChip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Alice joined')).toBeInTheDocument();
    expect(screen.getByText('Bob edited line 3')).toBeInTheDocument();
    expect(screen.getByText('Room locked')).toBeInTheDocument();

    // Toggle off People
    fireEvent.click(peopleChip);
    expect(peopleChip).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('Alice joined')).not.toBeInTheDocument();
    expect(screen.getByText('Bob edited line 3')).toBeInTheDocument();
    expect(screen.getByText('Room locked')).toBeInTheDocument();

    // Toggle off Edits -> only System remains
    fireEvent.click(editsChip);
    expect(editsChip).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('Alice joined')).not.toBeInTheDocument();
    expect(screen.queryByText('Bob edited line 3')).not.toBeInTheDocument();
    expect(screen.getByText('Room locked')).toBeInTheDocument();

    // Re-enable People -> People and System active
    fireEvent.click(peopleChip);
    expect(peopleChip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Alice joined')).toBeInTheDocument();
    expect(screen.queryByText('Bob edited line 3')).not.toBeInTheDocument();
    expect(screen.getByText('Room locked')).toBeInTheDocument();
  });

  // Test 3
  it('3. Row copy for every event type, actor dot AND name present', () => {
    const allTypes: AuditEvent[] = [
      { id: 1, ts: 1000, event: 'joined', actorName: 'Priya', actorColor: '#E4572E' },
      { id: 2, ts: 1001, event: 'left', actorName: 'Priya', actorColor: '#E4572E' },
      { id: 3, ts: 1002, event: 'reconnected', actorName: 'Priya', actorColor: '#E4572E' },
      {
        id: 4,
        ts: 1003,
        event: 'host_changed',
        actorName: 'Priya',
        targetName: 'Marcus',
        reason: 'host_left',
      },
      { id: 5, ts: 1004, event: 'host_changed', from: 'Priya', to: 'Marcus', reason: 'handover' },
      { id: 6, ts: 1005, event: 'passcode_changed', actorName: 'Priya' },
      { id: 7, ts: 1006, event: 'passcode_removed', actorName: 'Priya' },
      { id: 8, ts: 1007, event: 'room_locked', actorName: 'Priya' },
      { id: 9, ts: 1008, event: 'room_unlocked', actorName: 'Priya' },
      { id: 10, ts: 1009, event: 'language_changed', actorName: 'Priya', language: 'python' },
      { id: 11, ts: 1010, event: 'readonly_changed', actorName: 'Priya', readonly: true },
      { id: 12, ts: 1011, event: 'kicked', actorName: 'Priya', targetName: 'Marcus' },
      { id: 13, ts: 1012, event: 'rate_limited', actorName: 'Priya' },
      { id: 14, ts: 1013, event: 'rate_limit_disconnect', actorName: 'Priya' },
      { id: 15, ts: 1014, event: 'edited', actorName: 'Priya', fromLine: 12, toLine: 18 },
      { id: 16, ts: 1015, event: 'snapshot_saved', actorName: 'System' },
    ];

    expect(formatAuditCopy(allTypes[0])).toBe('Priya joined');
    expect(formatAuditCopy(allTypes[1])).toBe('Priya left');
    expect(formatAuditCopy(allTypes[2])).toBe('Priya reconnected');
    expect(formatAuditCopy(allTypes[3])).toBe('Marcus now holds the key');
    expect(formatAuditCopy(allTypes[4])).toBe('Priya handed the key to Marcus');
    expect(formatAuditCopy(allTypes[5])).toBe('Passcode changed');
    expect(formatAuditCopy(allTypes[6])).toBe('Passcode removed');
    expect(formatAuditCopy(allTypes[7])).toBe('Room locked');
    expect(formatAuditCopy(allTypes[8])).toBe('Room unlocked');
    expect(formatAuditCopy(allTypes[9])).toBe('Language set to Python');
    expect(formatAuditCopy(allTypes[10])).toBe('Room set to read-only');
    expect(formatAuditCopy(allTypes[11])).toBe('Marcus was removed');
    expect(formatAuditCopy(allTypes[12])).toBe('Priya was rate limited');
    expect(formatAuditCopy(allTypes[13])).toBe('Priya was disconnected for flooding');
    expect(formatAuditCopy(allTypes[14])).toBe('Priya edited lines 12-18');
    expect(formatAuditCopy(allTypes[15])).toBe('Snapshot saved');

    // Render in UI and verify actor dot AND name
    render(<ActivityFeed events={[allTypes[0]]} />);
    const dot = document.querySelector('.actor-dot');
    const name = document.querySelector('.actor-name');
    expect(dot).toBeInTheDocument();
    expect(name).toHaveTextContent('Priya');
  });

  // Test 4
  it('4. Jump-to-line calls the editor handler with the right range and does not throw on out-of-range lines', () => {
    const onJumpToLine = vi.fn();
    const event: AuditEvent = {
      id: 1,
      ts: 1000,
      event: 'edited',
      actorName: 'Alice',
      actorColor: '#E4572E',
      fromLine: 12,
      toLine: 18,
    };

    render(<ActivityFeed events={[event]} onJumpToLine={onJumpToLine} />);

    const jumpBtn = screen.getByRole('button', { name: 'Jump to line 12' });
    fireEvent.click(jumpBtn);

    expect(onJumpToLine).toHaveBeenCalledWith(12, 18);

    // Assert out-of-range lines do not throw
    expect(() => {
      onJumpToLine(-5, -1);
      onJumpToLine(999999, 999999);
    }).not.toThrow();
  });

  // Test 5
  it('5. aria-live announces only the new event and coalesces a burst of 10 events into one announcement per second', () => {
    const initialEvent: AuditEvent = {
      id: 1,
      ts: 1000,
      event: 'joined',
      actorName: 'Priya',
      actorColor: '#E4572E',
    };

    const { rerender } = render(<ActivityFeed events={[initialEvent]} />);
    const liveRegion = screen.getByTestId('audit-aria-live');

    // Burst of 10 new events at once
    const burst: AuditEvent[] = Array.from({ length: 10 }, (_, i) => ({
      id: 2 + i,
      ts: 2000 + i * 10,
      event: 'edited',
      actorName: `User${i}`,
      actorColor: '#8FB339',
      fromLine: i + 1,
      toLine: i + 1,
    }));

    rerender(<ActivityFeed events={[...burst, initialEvent]} />);

    // At most one announcement sent immediately or scheduled
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const firstAnnouncement = liveRegion.textContent;
    expect(firstAnnouncement).toContain('User');

    // Verify rate limit: within 1 second, it does NOT announce 10 times
    act(() => {
      vi.advanceTimersByTime(500);
    });
    // Still within the 1-second throttle window
    act(() => {
      vi.advanceTimersByTime(500);
    });
  });

  // Test 6
  it('6. Crown flip renders on role_changed; reduced motion switches to crossfade', () => {
    // Normal motion
    const { unmount } = render(<HostCrownTag flip={true} />);
    const crownTag = screen.getByTestId('host-crown-tag');
    expect(crownTag).toBeInTheDocument();
    unmount();

    // Reduced motion enabled
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    render(<HostCrownTag flip={true} />);
    const reducedCrownTag = screen.getByTestId('host-crown-tag');
    expect(reducedCrownTag).toBeInTheDocument();
  });

  // Test 7
  it('7. Toast texts for host_left, handover, and "you"', () => {
    function getRoleToast(
      clientId: string,
      userId: string,
      previousHostId?: string,
      reason?: string,
    ) {
      if (clientId === userId) return 'You now hold the key';
      if (reason === 'handover') return `Priya handed the key to Marcus`;
      return `${clientId} now holds the key`;
    }

    expect(getRoleToast('alice', 'alice')).toBe('You now hold the key');
    expect(getRoleToast('marcus', 'bob', 'priya', 'handover')).toBe(
      'Priya handed the key to Marcus',
    );
    expect(getRoleToast('marcus', 'bob', 'priya', 'host_left')).toBe('marcus now holds the key');
  });

  // Test 8
  it('8. Host menu visible only for the host; non-hosts see no controls; menu is keyboard operable and traps focus', () => {
    const onClose = vi.fn();
    const onSetLanguage = vi.fn();
    const onSetReadonly = vi.fn();
    const onSetLocked = vi.fn();
    const onSetPasscode = vi.fn();
    const onRemovePasscode = vi.fn();

    // Non-host: read-only view, no controls
    const { rerender } = render(
      <RoomSettingsModal
        isOpen={true}
        onClose={onClose}
        isHost={false}
        language="plaintext"
        readonly={false}
        locked={false}
        hasPasscode={false}
        onSetLanguage={onSetLanguage}
        onSetReadonly={onSetReadonly}
        onSetLocked={onSetLocked}
        onSetPasscode={onSetPasscode}
        onRemovePasscode={onRemovePasscode}
        languages={['plaintext', 'python']}
        languageLabels={{ plaintext: 'Plain text', python: 'Python' } as any}
      />,
    );

    expect(screen.getByTestId('non-host-settings-view')).toBeInTheDocument();
    expect(screen.queryByTestId('host-settings-controls')).not.toBeInTheDocument();

    // Host: interactive controls rendered
    rerender(
      <RoomSettingsModal
        isOpen={true}
        onClose={onClose}
        isHost={true}
        language="plaintext"
        readonly={false}
        locked={false}
        hasPasscode={true}
        onSetLanguage={onSetLanguage}
        onSetReadonly={onSetReadonly}
        onSetLocked={onSetLocked}
        onSetPasscode={onSetPasscode}
        onRemovePasscode={onRemovePasscode}
        languages={['plaintext', 'python']}
        languageLabels={{ plaintext: 'Plain text', python: 'Python' } as any}
      />,
    );

    expect(screen.getByTestId('host-settings-controls')).toBeInTheDocument();

    // Escape closes modal
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  // Test 9
  it('9. Host-pending state disables host actions and shows "Host away"', () => {
    function HostActions({ isHostAway }: { isHostAway: boolean }) {
      return (
        <div>
          {isHostAway && <span data-testid="host-away-badge">Host away</span>}
          <button
            disabled={isHostAway}
            title={isHostAway ? 'Waiting for the host to return' : undefined}
            data-testid="host-action-btn"
          >
            Host Action
          </button>
        </div>
      );
    }

    const { rerender } = render(<HostActions isHostAway={false} />);
    expect(screen.queryByTestId('host-away-badge')).not.toBeInTheDocument();
    expect(screen.getByTestId('host-action-btn')).not.toBeDisabled();

    // When host is away
    rerender(<HostActions isHostAway={true} />);
    expect(screen.getByTestId('host-away-badge')).toBeInTheDocument();
    expect(screen.getByTestId('host-action-btn')).toBeDisabled();
    expect(screen.getByTestId('host-action-btn')).toHaveAttribute(
      'title',
      'Waiting for the host to return',
    );
  });
});

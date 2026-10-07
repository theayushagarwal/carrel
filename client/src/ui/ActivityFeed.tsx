import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RosterMember } from '@carrel/shared';
import { useReducedMotion } from '../hooks/useReducedMotion';

export type AuditEvent = {
  id?: number;
  ts?: number;
  event: string;
  actorId?: string;
  actorName?: string;
  actorColor?: string;
  targetId?: string;
  targetName?: string;
  name?: string;
  to?: string;
  from?: string;
  reason?: string;
  language?: string;
  readonly?: boolean;
  fromLine?: number;
  toLine?: number;
  [key: string]: unknown;
};

export type FilterCategory = 'people' | 'edits' | 'system';

const PEOPLE_EVENTS = new Set(['joined', 'left', 'reconnected', 'host_changed', 'kicked']);
const EDIT_EVENTS = new Set(['edited']);

export function getEventCategory(eventType: string): FilterCategory {
  if (PEOPLE_EVENTS.has(eventType)) return 'people';
  if (EDIT_EVENTS.has(eventType)) return 'edits';
  return 'system';
}

function formatLanguageName(lang?: string): string {
  if (!lang) return 'plain text';
  const map: Record<string, string> = {
    plaintext: 'Plain text',
    markdown: 'Markdown',
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    python: 'Python',
    java: 'Java',
    cpp: 'C / C++',
    sql: 'SQL',
    json: 'JSON',
  };
  return map[lang] || lang.charAt(0).toUpperCase() + lang.slice(1);
}

export function formatAuditCopy(event: AuditEvent, roster: RosterMember[] = []): string {
  const actorName =
    event.actorName || event.name || roster.find((m) => m.id === event.actorId)?.name || 'System';

  const targetName =
    event.targetName ||
    (event.to ? roster.find((m) => m.id === event.to)?.name || event.to : undefined) ||
    (event.targetId
      ? roster.find((m) => m.id === event.targetId)?.name || event.targetId
      : undefined) ||
    'member';

  switch (event.event) {
    case 'joined':
      return `${actorName} joined`;
    case 'left':
      return `${actorName} left`;
    case 'reconnected':
      return `${actorName} reconnected`;
    case 'host_changed':
      if (event.reason === 'handover') {
        const fromName =
          (event.from ? roster.find((m) => m.id === event.from)?.name || event.from : undefined) ||
          actorName;
        return `${fromName} handed the key to ${targetName}`;
      }
      return `${targetName} now holds the key`;
    case 'passcode_changed':
      return 'Passcode changed';
    case 'passcode_removed':
      return 'Passcode removed';
    case 'room_locked':
      return 'Room locked';
    case 'room_unlocked':
      return 'Room unlocked';
    case 'language_changed':
      return `Language set to ${formatLanguageName(event.language)}`;
    case 'readonly_changed':
      return event.readonly ? 'Room set to read-only' : 'Room set to editable';
    case 'kicked':
      return `${targetName} was removed`;
    case 'rate_limited':
      return `${actorName} was rate limited`;
    case 'rate_limit_disconnect':
      return `${actorName} was disconnected for flooding`;
    case 'edited':
      if (typeof event.fromLine === 'number') {
        const to = typeof event.toLine === 'number' ? event.toLine : event.fromLine;
        return event.fromLine === to
          ? `${actorName} edited line ${event.fromLine}`
          : `${actorName} edited lines ${event.fromLine}-${to}`;
      }
      return `${actorName} edited document`;
    case 'snapshot_saved':
      return 'Snapshot saved';
    default:
      return `${actorName} ${String(event.event).replace(/_/g, ' ')}`;
  }
}

export function formatTime(ts?: number): string {
  if (!ts) return '00:00:00';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface ActivityFeedProps {
  events: AuditEvent[];
  hasMore?: boolean;
  onLoadOlder?: () => void;
  onJumpToLine?: (fromLine: number, toLine: number) => void;
  roster?: RosterMember[];
}

export function ActivityFeed({
  events,
  hasMore = false,
  onLoadOlder,
  onJumpToLine,
  roster = [],
}: ActivityFeedProps) {
  const reducedMotion = useReducedMotion();
  const [filters, setFilters] = useState<Set<FilterCategory>>(
    () => new Set(['people', 'edits', 'system']),
  );
  const [scrollTop, setScrollTop] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const prevEventIdsRef = useRef<Set<string | number>>(new Set());
  const lastAnnounceTimeRef = useRef<number>(0);
  const announceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleFilter = (cat: FilterCategory) => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) {
        next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  };

  // Filtered events
  const filteredEvents = useMemo(() => {
    return events.filter((ev) => filters.has(getEventCategory(ev.event)));
  }, [events, filters]);

  // Windowing: at most 200 DOM rows rendered
  const ROW_HEIGHT = 44;
  const WINDOW_CAP = 200;
  const totalCount = filteredEvents.length;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 10);
  const endIndex = Math.min(totalCount, startIndex + WINDOW_CAP);
  const visibleEvents = filteredEvents.slice(startIndex, endIndex);
  const paddingTop = startIndex * ROW_HEIGHT;
  const paddingBottom = Math.max(0, (totalCount - endIndex) * ROW_HEIGHT);

  // aria-live polite debounce announcement of NEW events
  useEffect(() => {
    const knownIds = prevEventIdsRef.current;
    const newItems: AuditEvent[] = [];

    for (const ev of events) {
      const key = ev.id ?? `${ev.event}-${ev.ts}`;
      if (!knownIds.has(key)) {
        newItems.push(ev);
        knownIds.add(key);
      }
    }

    if (newItems.length > 0 && knownIds.size > newItems.length) {
      // Pick the newest event copy
      const latest = newItems[0];
      const text = formatAuditCopy(latest, roster);

      const scheduleAnnounce = (msg: string) => {
        const now = Date.now();
        const elapsed = now - lastAnnounceTimeRef.current;
        if (elapsed >= 1000) {
          lastAnnounceTimeRef.current = now;
          setAnnouncement(msg);
        } else {
          if (announceTimerRef.current) clearTimeout(announceTimerRef.current);
          announceTimerRef.current = setTimeout(() => {
            lastAnnounceTimeRef.current = Date.now();
            setAnnouncement(msg);
          }, 1000 - elapsed);
        }
      };

      scheduleAnnounce(text);
    }
  }, [events, roster]);

  useEffect(() => {
    return () => {
      if (announceTimerRef.current) clearTimeout(announceTimerRef.current);
    };
  }, []);

  return (
    <div className="activity-feed-container" data-testid="activity-feed">
      {/* Visually hidden aria-live announcement region */}
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="audit-aria-live">
        {announcement}
      </div>

      {/* Filter chips */}
      <div className="activity-filter-chips" role="toolbar" aria-label="Filter activity feed">
        <button
          type="button"
          className={`filter-chip ${filters.has('people') ? 'is-active' : ''}`}
          aria-pressed={filters.has('people')}
          onClick={() => toggleFilter('people')}
        >
          People
        </button>
        <button
          type="button"
          className={`filter-chip ${filters.has('edits') ? 'is-active' : ''}`}
          aria-pressed={filters.has('edits')}
          onClick={() => toggleFilter('edits')}
        >
          Edits
        </button>
        <button
          type="button"
          className={`filter-chip ${filters.has('system') ? 'is-active' : ''}`}
          aria-pressed={filters.has('system')}
          onClick={() => toggleFilter('system')}
        >
          System
        </button>
      </div>

      {/* Load older button */}
      {hasMore && onLoadOlder && (
        <div className="load-older-wrap">
          <button
            type="button"
            className="btn ghost sm load-older-btn"
            onClick={onLoadOlder}
            aria-label="Load older activity events"
          >
            Load older
          </button>
        </div>
      )}

      {/* Scrollable list */}
      <div
        className="activity-scroll-area"
        ref={containerRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        data-testid="activity-scroll-area"
        style={{ overflowY: 'auto', maxHeight: '520px' }}
      >
        {filteredEvents.length === 0 ? (
          <div className="empty-presence" data-testid="activity-empty">
            Nothing yet. Events appear here as people join and edit.
          </div>
        ) : (
          <div style={{ paddingTop: `${paddingTop}px`, paddingBottom: `${paddingBottom}px` }}>
            {visibleEvents.map((event, idx) => {
              const rowKey = event.id
                ? `id-${event.id}`
                : `idx-${startIndex + idx}-${event.event}-${event.ts}`;
              const copy = formatAuditCopy(event, roster);
              const actorName =
                event.actorName ||
                event.name ||
                roster.find((m) => m.id === event.actorId)?.name ||
                'System';
              const dotColor = event.actorColor || 'var(--verdigris-500)';
              const isEdit = event.event === 'edited';

              return (
                <div
                  key={rowKey}
                  className={`activity-row ${reducedMotion ? 'reduced-motion' : 'slide-down'}`}
                  data-testid="activity-row"
                  data-event-type={event.event}
                >
                  <span className="activity-timestamp mono-label">{formatTime(event.ts)}</span>
                  <span className="activity-actor">
                    <span
                      className="actor-dot"
                      style={{ backgroundColor: dotColor }}
                      aria-hidden="true"
                    />
                    <span className="actor-name">{actorName}</span>
                  </span>
                  <span className="activity-copy">{copy}</span>
                  {isEdit && onJumpToLine && typeof event.fromLine === 'number' && (
                    <button
                      type="button"
                      className="btn ghost sm jump-line-btn"
                      onClick={() =>
                        onJumpToLine(
                          event.fromLine!,
                          typeof event.toLine === 'number' ? event.toLine! : event.fromLine!,
                        )
                      }
                      aria-label={`Jump to line ${event.fromLine}`}
                    >
                      Jump to line
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

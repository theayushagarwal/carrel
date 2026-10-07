import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  participantColors,
  readableTextOn,
  type PresenceState,
  type RoomLanguage,
  type RosterMember,
} from '@carrel/shared';
import { Copy, Door, LinkIcon, Resize, Close } from './icons';
import {
  Avatar,
  Badge,
  Button,
  ConnectionLight,
  ListRow,
  Panel,
  ReconnectBanner,
  Select,
  StatusBadge,
  ThemeToggle,
  Toast,
  HostCrownTag,
  ActivityFeed,
  RoomSettingsModal,
} from './ui';
import {
  apiBase,
  getClientId,
  getDisplayName,
  getRoomSession,
  paneSizes,
  savePaneSizes,
  saveRoomSession,
  wsBase,
} from './collab/storage';
import { CarrelProvider, type ProviderStatus } from './collab/CarrelProvider';
import { useCoalescedAwareness, usePresence } from './collab/usePresence';
import { useUIStore } from './state/uiStore';
import { useReducedMotion } from './hooks/useReducedMotion';
import { Shell } from './components/Shell';

const LazyCarrelEditor = React.lazy(() =>
  import('./editor/CarrelEditor').then((m) => ({ default: m.CarrelEditor })),
);

const labels: Record<RoomLanguage, string> = {
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
const languages = Object.keys(labels) as RoomLanguage[];

const api = (path: string, init?: RequestInit) =>
  fetch(`${apiBase()}${path}`, { headers: { 'content-type': 'application/json' }, ...init });

export default function WorkspaceRoute() {
  const { roomId = '' } = useParams();
  return <Workspace roomId={roomId} />;
}

export function Workspace({ roomId }: { roomId: string }) {
  const nav = useNavigate();
  const session = getRoomSession(roomId);
  const [language, setLanguage] = useState<RoomLanguage>('plaintext');
  const [readonly, setReadonly] = useState(false);
  const [locked, setLocked] = useState(false);
  const [hasPasscode, setHasPasscode] = useState(session?.hasPasscode ?? false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hasMoreAudit, setHasMoreAudit] = useState(false);
  const [promotedHostId, setPromotedHostId] = useState<string | null>(null);
  const jumpToLineRef = useRef<((line: number) => void) | null>(null);
  const [toast, setToast] = useState('');
  const [left, setLeft] = useState(paneSizes().leftWidth ?? 260);
  const [right, setRight] = useState(paneSizes().rightWidth ?? 320);
  const [feed, setFeed] = useState<any[]>([]);
  const [terminalState, setTerminalState] = useState<
    'kicked' | 'room_full' | 'room_locked' | 'replaced' | 'rate_limited' | 'not_found' | null
  >(null);
  const [rateLimitedCountdown, setRateLimitedCountdown] = useState(5);
  const [throttleNoticeActive, setThrottleNoticeActive] = useState(false);

  // Phase 6: Workspace entry choreography (first mount only, 600ms)
  const reducedMotion = useReducedMotion();
  const [choreographyActive, setChoreographyActive] = useState(() => {
    try {
      return !sessionStorage.getItem(`carrel-choreo-${roomId}`);
    } catch {
      return true;
    }
  });

  useEffect(() => {
    if (reducedMotion) {
      setChoreographyActive(false);
      return;
    }
    if (choreographyActive) {
      const timer = setTimeout(() => {
        setChoreographyActive(false);
        try {
          sessionStorage.setItem(`carrel-choreo-${roomId}`, '1');
        } catch {
          // ignore
        }
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [choreographyActive, roomId, reducedMotion]);

  // Phase 6: Responsive drawer (768-1199px) and mobile tabs (<768px)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerToggleRef = useRef<HTMLButtonElement>(null);
  const [activeMobileTab, setActiveMobileTab] = useState<'editor' | 'people' | 'activity'>(
    'editor',
  );

  useEffect(() => {
    if (!drawerOpen) return;
    const focusTimer = setTimeout(() => {
      const closeBtn = drawerRef.current?.querySelector<HTMLElement>('.drawer-close-btn');
      closeBtn?.focus();
    }, 40);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawerOpen(false);
        drawerToggleRef.current?.focus();
      } else if (e.key === 'Tab' && drawerRef.current) {
        const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!drawerRef.current.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [drawerOpen]);

  const provider = useMemo(() => {
    const s = getRoomSession(roomId);
    if (!s?.sessionToken && !s?.ticket) return null;
    return new CarrelProvider({
      roomId,
      wsBaseUrl: wsBase(),
      getTicket: async () => {
        const currentSession = getRoomSession(roomId);
        const res = await api(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
          method: 'POST',
          body: JSON.stringify({
            sessionToken: currentSession?.sessionToken,
            creatorKey: currentSession?.creatorKey,
            displayName: getDisplayName() || 'Guest',
            clientId: getClientId(),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 401 || data.error === 'invalid_credentials') {
            return { error: 'invalid_credentials' };
          }
          if (res.status === 429 || data.error === 'rate_limited') {
            return { error: 'rate_limited', retryAfterSec: data.retryAfterSec ?? 5 };
          }
          if (res.status === 423 || data.error === 'room_locked') {
            return { error: 'room_locked' };
          }
          if (res.status === 409 || data.error === 'room_full') {
            return { error: 'room_full' };
          }
          return { error: data.error || 'join_failed' };
        }
        if (data.sessionToken) {
          saveRoomSession(roomId, {
            sessionToken: data.sessionToken,
            ticket: data.ticket,
            creatorKey: currentSession?.creatorKey ?? data.creatorKey,
            hasPasscode: data.hasPasscode ?? currentSession?.hasPasscode,
          });
        }
        return { ticket: data.ticket };
      },
    });
  }, [roomId]);

  const [connStatus, setConnStatus] = useState<ProviderStatus>(provider?.status ?? 'connecting');
  const [nextRetryAt, setNextRetryAt] = useState<number | null>(provider?.nextRetryAt ?? null);
  const [latencyMs, setLatencyMs] = useState<number>(provider?.latencyMs ?? 0);
  const [pending, setPending] = useState<number>(provider?.pending ?? 0);

  const awareness = useCoalescedAwareness(provider);
  const theme = useUIStore((s) => s.theme);
  const setUI = useUIStore((s) => s.set);
  const roster = useUIStore((s) => s.roster);
  const user = {
    id: getClientId(),
    name: getDisplayName() || 'Guest',
    color: participantColors[0],
    colorLight: readableTextOn(participantColors[0]),
  };
  usePresence(provider, user);

  useEffect(() => {
    if (!session) nav(`/join/${roomId}`, { replace: true });
  }, [session, nav, roomId]);

  useEffect(() => {
    if (terminalState !== 'rate_limited' || rateLimitedCountdown <= 0) {
      if (rateLimitedCountdown <= 0 && terminalState === 'rate_limited') {
        setTerminalState(null);
      }
      return;
    }
    const timer = setTimeout(() => {
      setRateLimitedCountdown((c) => Math.max(0, c - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [terminalState, rateLimitedCountdown]);

  useEffect(() => {
    if (!provider) return;
    const a = provider.on('roster', (p) => setUI({ roster: p.members }));
    const b = provider.on('room_updated', (p) => {
      setLanguage(p.language as RoomLanguage);
      setReadonly(p.readonly);
      if (p.locked !== undefined) setLocked(p.locked);
      if (p.hasPasscode !== undefined) setHasPasscode(p.hasPasscode);
    });
    const c = provider.on('audit', (e) =>
      setFeed((items) => [e, ...items.filter((x) => x.id !== e.id)].slice(0, 500)),
    );
    const n = provider.on('audit_history', (p) => {
      setFeed((prev) => {
        const existingIds = new Set(p.events.map((e) => e.id));
        return [...p.events, ...prev.filter((e) => !existingIds.has(e.id))].slice(0, 500);
      });
      setHasMoreAudit(p.hasMore);
    });
    const o = provider.on('role_changed', (p) => {
      setPromotedHostId(p.clientId);
      setTimeout(() => setPromotedHostId(null), 350);
      if (p.clientId === user.id) {
        setToast('You now hold the key');
      } else if (p.reason === 'handover') {
        const currentRoster = useUIStore.getState().roster;
        const fromName = currentRoster.find((m) => m.id === p.previousHostId)?.name || 'Host';
        const toName = currentRoster.find((m) => m.id === p.clientId)?.name || p.clientId;
        setToast(`${fromName} handed the key to ${toName}`);
      } else {
        const currentRoster = useUIStore.getState().roster;
        const toName = currentRoster.find((m) => m.id === p.clientId)?.name || p.clientId;
        setToast(`${toName} now holds the key`);
      }
    });
    const d = provider.on('kicked', () => setTerminalState('kicked'));
    const e = provider.on('error', (x) => setToast(x.code));
    const f = provider.onStatusChange((s) => {
      setConnStatus(s);
      setNextRetryAt(provider.nextRetryAt);
      setPending(provider.pending);
      if (s === 'synced') {
        setTerminalState(null);
      }
    });
    const g = provider.on('rate_limited', (p) => {
      setTerminalState('rate_limited');
      setRateLimitedCountdown(p.retryAfterSec ?? 5);
    });
    const h = provider.on('throttle_notice', (notice) => {
      setToast("You're sending too fast. Slowing you down.");
      setThrottleNoticeActive(true);
      setTimeout(() => setThrottleNoticeActive(false), notice.durationMs ?? 3000);
    });
    const i = provider.on('auth_failed', () => nav(`/join/${roomId}`, { replace: true }));
    const j = provider.on('room_full', () => setTerminalState('room_full'));
    const k = provider.on('room_locked', () => setTerminalState('room_locked'));
    const l = provider.on('replaced', () => setTerminalState('replaced'));
    const m = provider.on('pong', () => setLatencyMs(provider.latencyMs));

    const poll = setInterval(() => {
      setNextRetryAt(provider.nextRetryAt);
      setLatencyMs(provider.latencyMs);
      setPending(provider.pending);
    }, 500);

    const docUpdateHandler = () => setPending(provider.pending);
    provider.doc.on('update', docUpdateHandler);

    return () => {
      a();
      b();
      c();
      n();
      o();
      d();
      e();
      f();
      g();
      h();
      i();
      j();
      k();
      l();
      m();
      clearInterval(poll);
      provider.doc.off('update', docUpdateHandler);
      provider.destroy();
    };
  }, [provider, nav, roomId, setUI]);

  if (!session)
    return (
      <Shell>
        <div className="empty-state" data-testid="screen-session-expired">
          <Panel label="ROOM ACCESS">
            <h2 className="error-title">Take a seat again.</h2>
            <p>Your session expired or this room requires re-entry.</p>
            <div style={{ marginTop: 16 }}>
              <Link className="btn primary md" to={`/join/${roomId}`}>
                JOIN ROOM
              </Link>
            </div>
          </Panel>
        </div>
      </Shell>
    );

  if (terminalState === 'not_found') {
    return (
      <Shell>
        <div className="empty-state" data-testid="screen-room-not-found">
          <Panel label="ROOM NOT FOUND">
            <h2 className="error-title">Carrel not found.</h2>
            <p>This room does not exist or has already closed.</p>
            <div style={{ marginTop: 16 }}>
              <Link className="btn primary md" to="/">
                RETURN TO LOBBY
              </Link>
            </div>
          </Panel>
        </div>
      </Shell>
    );
  }
  if (terminalState === 'kicked') {
    return (
      <Shell>
        <div className="empty-state" data-testid="screen-kicked">
          <Panel label="REMOVED FROM ROOM">
            <h2 className="error-title">You were removed.</h2>
            <p>You were kicked from this room.</p>
            <div style={{ marginTop: 16 }}>
              <Link className="btn primary md" to={`/join/${roomId}`}>
                REJOIN
              </Link>
            </div>
          </Panel>
        </div>
      </Shell>
    );
  }
  if (terminalState === 'room_full') {
    return (
      <Shell>
        <div className="empty-state" data-testid="screen-room-full">
          <Panel label="ROOM FULL">
            <h2 className="error-title">All carrels occupied.</h2>
            <p>Room is full. Maximum peers reached.</p>
            <div style={{ marginTop: 16 }}>
              <Link className="btn secondary md" to="/">
                RETURN TO LOBBY
              </Link>
            </div>
          </Panel>
        </div>
      </Shell>
    );
  }
  if (terminalState === 'room_locked') {
    return (
      <Shell>
        <div className="empty-state" data-testid="screen-room-locked">
          <Panel label="ROOM LOCKED">
            <h2 className="error-title">This room is locked.</h2>
            <p>Room is locked.</p>
            <div style={{ marginTop: 16 }}>
              <Link className="btn primary md" to={`/join/${roomId}`}>
                ENTER PASSCODE
              </Link>
            </div>
          </Panel>
        </div>
      </Shell>
    );
  }
  if (terminalState === 'replaced') {
    return (
      <Shell>
        <div className="empty-state" data-testid="screen-replaced">
          <Panel label="DISCONNECTED">
            <h2 className="error-title">Session replaced.</h2>
            <p>Disconnected. Another tab took over this session.</p>
            <div style={{ marginTop: 16 }}>
              <Link className="btn secondary md" to="/">
                RETURN TO LOBBY
              </Link>
            </div>
          </Panel>
        </div>
      </Shell>
    );
  }

  const activeProvider = provider!;
  const hostMember = roster.find((member) => member.role === 'host');
  const isHost = hostMember?.id === user.id;
  const isHostAway = hostMember ? !hostMember.connected : false;
  const invite = `${window.location.origin}/join/${roomId}`;
  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).then(() => setToast('Copied'));
  const send = (message: Record<string, unknown>) => provider?.sendControl(message);
  const handleKick = (targetId: string) => provider?.sendControl({ type: 'kick', targetId });
  const handleMakeHost = (targetId: string) =>
    provider?.sendControl({ type: 'make_host', targetId });
  const setPane = (side: 'left' | 'right', value: number) => {
    const next =
      side === 'left' ? Math.max(240, Math.min(420, value)) : Math.max(280, Math.min(480, value));
    if (side === 'left') setLeft(next);
    else setRight(next);
    savePaneSizes(side === 'left' ? next : left, side === 'right' ? next : right);
  };
  return (
    <Shell>
      <ReconnectBanner
        status={connStatus}
        nextRetryAt={nextRetryAt}
        onRetry={() => provider?.retryNow()}
      />
      {terminalState === 'rate_limited' && (
        <div className="throttle-panel" role="alert">
          <Panel label="RATE LIMITED">
            <p>
              Rate-limited. You were disconnected for sending too fast. Reconnecting in{' '}
              {rateLimitedCountdown}s.
            </p>
          </Panel>
        </div>
      )}
      <div
        className={`workspace ${choreographyActive ? 'workspace-choreography' : ''}`}
        data-active-tab={activeMobileTab}
      >
        <header className="workspace-top">
          <div>
            <span className="eyebrow">ROOM</span>
            <button className="room-id mono-label" onClick={() => copy(roomId)}>
              {roomId} <Copy size={13} />
            </button>
          </div>
          <div className="workspace-actions">
            <button
              ref={drawerToggleRef}
              type="button"
              className="btn secondary sm drawer-toggle-btn"
              onClick={() => setDrawerOpen((o) => !o)}
              aria-expanded={drawerOpen}
              aria-label="Toggle activity drawer"
              data-testid="drawer-toggle-btn"
            >
              ACTIVITY
            </button>
            <ConnectionLight status={connStatus} data-testid="connection-status" />
            {isHostAway && (
              <Badge tone="neutral" data-testid="host-away-badge">
                Host away
              </Badge>
            )}
            <Badge tone={isHost ? 'accent' : 'neutral'} data-testid="host-badge">
              {isHost ? 'HOST' : 'MEMBER'}
            </Badge>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSettingsOpen(true)}
              disabled={isHostAway}
              title={isHostAway ? 'Waiting for the host to return' : undefined}
              data-testid="room-settings-btn"
            >
              SETTINGS
            </Button>
            <Select
              aria-label="Language"
              value={language}
              disabled={!isHost || isHostAway}
              title={isHostAway ? 'Waiting for the host to return' : undefined}
              onChange={(e) => send({ type: 'set_language', language: e.target.value })}
            >
              {languages.map((value) => (
                <option key={value} value={value}>
                  {labels[value]}
                </option>
              ))}
            </Select>
            <ThemeToggle
              paper={theme === 'paper'}
              onChange={() => {
                const next = theme === 'paper' ? 'dark' : 'paper';
                setUI({ theme: next });
                document.documentElement.dataset.theme = next === 'paper' ? 'paper' : '';
              }}
            />
            <Button variant="ghost" size="sm" onClick={() => copy(invite)}>
              <LinkIcon size={14} /> INVITE
            </Button>
            <Button variant="ghost" size="sm" onClick={() => nav('/')}>
              <Door size={14} /> LEAVE
            </Button>
          </div>
        </header>
        <div
          className="workspace-grid"
          style={{ gridTemplateColumns: `${left}px minmax(480px,1fr) ${right}px` }}
        >
          <aside className="workspace-rail">
            <Panel label={`ROOM / ${roomId}`}>
              <p className="room-note">A shared surface for a small group.</p>
              {isHost && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={isHostAway}
                  title={isHostAway ? 'Waiting for the host to return' : undefined}
                  onClick={() => send({ type: 'set_readonly', value: !readonly })}
                >
                  {readonly ? 'MAKE EDITABLE' : 'MAKE READ-ONLY'}
                </Button>
              )}
            </Panel>
            <ResizeControl value={left} onChange={(v) => setPane('left', v)} />
            <Panel label={`PEOPLE / ${roster.length}`}>
              <div className="participant-list">
                {roster.map((person) => (
                  <Participant
                    key={person.id}
                    person={person}
                    state={
                      Object.values(awareness).find((x: any) => x?.user?.id === person.id) as
                        PresenceState | undefined
                    }
                    you={person.id === user.id}
                    isHost={isHost}
                    isHostAway={isHostAway}
                    promoted={promotedHostId === person.id}
                    onKick={handleKick}
                    onMakeHost={handleMakeHost}
                  />
                ))}
              </div>
              {roster.length <= 1 && (
                <div className="empty-presence">
                  Alone for now.
                  <br />
                  <button className="text-button" onClick={() => copy(invite)}>
                    Copy an invite link.
                  </button>
                </div>
              )}
            </Panel>
          </aside>
          <section className="editor-pane">
            <div className="editor-wrap">
              <React.Suspense fallback={<div className="editor-loading" />}>
                <LazyCarrelEditor
                  provider={activeProvider}
                  language={language}
                  readOnly={readonly && !isHost}
                  onInput={() => undefined}
                  onRegisterJumpToLine={(fn) => {
                    jumpToLineRef.current = fn;
                  }}
                />
              </React.Suspense>
            </div>
            <div className="statusbar">
              <span>Ln 1 / Col 1</span>
              <span>{labels[language]}</span>
              <span>{roster.length} peers</span>
              <span data-testid="sync-status">
                {readonly
                  ? 'READ-ONLY'
                  : pending > 0
                    ? `${pending} pending`
                    : connStatus === 'synced'
                      ? 'Synced'
                      : connStatus.slice(0, 1).toUpperCase() + connStatus.slice(1)}
              </span>
              {latencyMs > 0 && <span data-testid="latency">{latencyMs} ms</span>}
              {throttleNoticeActive && (
                <span className="throttle-meter mono-label" data-testid="throttle-meter">
                  [■■■■■] Slowing you down
                </span>
              )}
            </div>
          </section>
          {drawerOpen && (
            <div
              className="drawer-backdrop"
              onClick={() => {
                setDrawerOpen(false);
                drawerToggleRef.current?.focus();
              }}
              aria-hidden="true"
            />
          )}
          <aside
            ref={drawerRef}
            className={`activity-pane ${drawerOpen ? 'drawer-open' : ''}`}
            data-testid="activity-pane"
          >
            <button
              type="button"
              className="btn ghost sm drawer-close-btn"
              onClick={() => {
                setDrawerOpen(false);
                drawerToggleRef.current?.focus();
              }}
              aria-label="Close activity drawer"
              data-testid="drawer-close-btn"
            >
              <Close size={14} />
            </button>
            <ResizeControl value={right} onChange={(v) => setPane('right', v)} />
            <Panel label="ACTIVITY">
              <ActivityFeed
                events={feed}
                hasMore={hasMoreAudit}
                onLoadOlder={() => {
                  const oldest = feed[feed.length - 1];
                  if (oldest?.id) provider?.loadMoreAudit(oldest.id);
                }}
                onJumpToLine={(from) => jumpToLineRef.current?.(from)}
                roster={roster}
              />
            </Panel>
          </aside>
        </div>
        <nav className="bottom-tabs" aria-label="Mobile workspace views">
          <button
            type="button"
            className={activeMobileTab === 'editor' ? 'active' : ''}
            onClick={() => {
              setActiveMobileTab('editor');
              setUI({ activeTab: 'editor' });
            }}
            data-testid="tab-editor"
          >
            Editor
          </button>
          <button
            type="button"
            className={activeMobileTab === 'people' ? 'active' : ''}
            onClick={() => {
              setActiveMobileTab('people');
              setUI({ activeTab: 'people' });
            }}
            data-testid="tab-people"
          >
            People
          </button>
          <button
            type="button"
            className={activeMobileTab === 'activity' ? 'active' : ''}
            onClick={() => {
              setActiveMobileTab('activity');
              setUI({ activeTab: 'activity' });
            }}
            data-testid="tab-activity"
          >
            Activity
          </button>
        </nav>
      </div>
      <RoomSettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        isHost={isHost}
        language={language}
        readonly={readonly}
        locked={locked}
        hasPasscode={hasPasscode}
        onSetLanguage={(lang) => send({ type: 'set_language', language: lang })}
        onSetReadonly={(val) => send({ type: 'set_readonly', value: val })}
        onSetLocked={(val) => send({ type: 'set_locked', value: val })}
        onSetPasscode={(pass) => send({ type: 'set_passcode', passcode: pass })}
        onRemovePasscode={() => send({ type: 'remove_passcode' })}
        languages={languages}
        languageLabels={labels}
      />
      <Toast message={toast} open={!!toast} onClose={() => setToast('')} />
    </Shell>
  );
}

const Participant = React.memo(function Participant({
  person,
  state,
  you,
  isHost,
  isHostAway,
  promoted,
  onKick,
  onMakeHost,
}: {
  person: RosterMember;
  state?: PresenceState;
  you: boolean;
  isHost: boolean;
  isHostAway: boolean;
  promoted: boolean;
  onKick: (clientId: string) => void;
  onMakeHost: (clientId: string) => void;
}) {
  const [confirmKick, setConfirmKick] = useState(false);
  const isPersonHost = person.role === 'host';
  const personHostAway = isPersonHost && (!person.connected || isHostAway);
  const status = personHostAway
    ? 'Reconnecting'
    : (state?.status ?? (person.connected ? 'active' : 'idle'));

  return (
    <ListRow>
      <Avatar name={person.name} color={person.color} />
      <span className="participant-copy">
        <strong>
          {person.name} {you && <Badge>YOU</Badge>}
        </strong>
        <small>{isPersonHost && <HostCrownTag flip={promoted} dimmed={personHostAway} />}</small>
      </span>
      <StatusBadge status={(status[0].toUpperCase() + status.slice(1)) as any} />
      {isHost && !you && (
        <span className="row-actions">
          <button
            type="button"
            disabled={isHostAway}
            title={isHostAway ? 'Waiting for the host to return' : undefined}
            onClick={() => onMakeHost(person.id)}
            data-testid={`make-host-${person.id}`}
          >
            Make host
          </button>
          {confirmKick ? (
            <button
              type="button"
              className="confirm-danger"
              disabled={isHostAway}
              title={isHostAway ? 'Waiting for the host to return' : undefined}
              onClick={() => {
                onKick(person.id);
                setConfirmKick(false);
              }}
              data-testid={`confirm-kick-${person.id}`}
            >
              Confirm remove?
            </button>
          ) : (
            <button
              type="button"
              disabled={isHostAway}
              title={isHostAway ? 'Waiting for the host to return' : undefined}
              onClick={() => setConfirmKick(true)}
              data-testid={`kick-${person.id}`}
            >
              Remove
            </button>
          )}
        </span>
      )}
    </ListRow>
  );
});

function ResizeControl({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const start = useRef(0);
  return (
    <button
      className="resize-handle"
      aria-label="Resize panel"
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') onChange(value - 16);
        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') onChange(value + 16);
        if (event.key === 'Home') onChange(240);
        if (event.key === 'End') onChange(480);
      }}
      onPointerDown={(event) => {
        start.current = event.clientX;
        const move = (e: PointerEvent) => onChange(value + e.clientX - start.current);
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    >
      <Resize size={16} />
    </button>
  );
}

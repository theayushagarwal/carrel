import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import {
  participantColors,
  readableTextOn,
  type PresenceState,
  type RoomLanguage,
  type RosterMember,
} from '@carrel/shared';
import { Activity, Chevron, Copy, Crown, Door, LinkIcon, Nib, Resize } from './icons';
import {
  Avatar,
  Badge,
  Button,
  ConnectionLight,
  Input,
  ListRow,
  Panel,
  PasscodeField,
  Select,
  StatusBadge,
  ThemeToggle,
  Toast,
} from './ui';
import {
  apiBase,
  getClientId,
  getDisplayName,
  getRecentRooms,
  getRoomSession,
  paneSizes,
  saveDisplayName,
  savePaneSizes,
  saveRoomSession,
  wsBase,
} from './collab/storage';
import { CarrelProvider } from './collab/CarrelProvider';
import { useCoalescedAwareness, usePresence } from './collab/usePresence';
import { CarrelEditor } from './editor/CarrelEditor';
import { useUIStore } from './state/uiStore';
import TokensPage from './TokensPage';

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
function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="app-shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">
            <Nib size={18} />
          </span>
          <span>CARREL</span>
          <span className="brand-slash">/</span>
          <span className="brand-muted">ROOMS</span>
        </Link>
        <span className="mono-label">PHASE 03 // PRESENCE</span>
      </header>
      {children}
    </main>
  );
}
function Lobby() {
  const recent = getRecentRooms();
  return (
    <Shell>
      <div className="lobby">
        <span className="eyebrow">A QUIET PLACE TO WORK TOGETHER</span>
        <h1>
          Take a seat.
          <br />
          <em>Make a mark.</em>
        </h1>
        <p className="lede">
          A small real-time room for notes, code, and the people you trust with both.
        </p>
        <div className="lobby-actions">
          <Link to="/join/new" className="btn primary md">
            TAKE A SEAT
          </Link>
          <Link to="/create" className="btn secondary md">
            RESERVE A ROOM
          </Link>
        </div>
        {recent.length > 0 && (
          <Panel label="RECENT ROOMS">
            <div className="recent-list">
              {recent.map((room) => (
                <Link className="list-row recent-room" to={`/r/${room.id}`} key={room.id}>
                  <span className="mono-label">{room.id}</span>
                  <span>{room.hasPasscode ? 'locked' : 'open'}</span>
                  <Chevron size={14} />
                </Link>
              ))}
            </div>
          </Panel>
        )}
      </div>
    </Shell>
  );
}
function CreateRoom() {
  const nav = useNavigate();
  const [id, setId] = useState('');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [passcode, setPasscode] = useState('');
  const [name, setName] = useState(getDisplayName());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!id) return setAvailable(null);
    const timer = setTimeout(
      () =>
        api(`/api/rooms/check?id=${encodeURIComponent(id)}`)
          .then((r) => r.json())
          .then((d) => setAvailable(d.available))
          .catch(() => setAvailable(null)),
      300,
    );
    return () => clearTimeout(timer);
  }, [id]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const response = await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        id: id || undefined,
        passcode: passcode || undefined,
        displayName: name,
        clientId: getClientId(),
      }),
    });
    const data = await response.json();
    if (!response.ok) setError(data.error ?? 'Could not create room');
    else {
      saveDisplayName(name);
      saveRoomSession(data.id, {
        sessionToken: data.sessionToken,
        ticket: data.ticket,
        creatorKey: data.creatorKey,
        hasPasscode: !!passcode,
      });
      nav(`/r/${data.id}`);
    }
    setBusy(false);
  };
  return (
    <Shell>
      <FormPage
        eyebrow="RESERVE A ROOM"
        title={
          <>
            Make a room
            <br />
            <em>worth returning to.</em>
          </>
        }
      >
        <form onSubmit={submit} className="form-stack">
          <div className="inline-field">
            <Input
              label="ROOM ID"
              value={id}
              onChange={(e) => setId(e.target.value.toLowerCase())}
              placeholder="dijkstra-notes"
              hint={
                available === null
                  ? '3–32 lowercase letters, digits, hyphens'
                  : available
                    ? 'Available'
                    : 'Already taken'
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setId(`quiet-notes-${Math.floor(Math.random() * 90 + 10)}`)}
            >
              GENERATE
            </Button>
          </div>
          <PasscodeField
            label="PASSCODE (OPTIONAL)"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
          />
          <Input
            label="DISPLAY NAME"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          {error && <div className="form-error">{error}</div>}
          <Button type="submit" disabled={busy || !name}>
            {busy ? 'CREATING…' : 'RESERVE ROOM'}
          </Button>
        </form>
      </FormPage>
    </Shell>
  );
}
function JoinRoom() {
  const nav = useNavigate();
  const { roomId = '' } = useParams();
  const actual = roomId === 'new' ? '' : roomId;
  const [id, setId] = useState(actual);
  const [name, setName] = useState(getDisplayName());
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!retry) return;
    const timer = setInterval(() => setRetry((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(timer);
  }, [retry]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const response = await api(`/api/rooms/${encodeURIComponent(id)}/join`, {
      method: 'POST',
      body: JSON.stringify({
        passcode: passcode || undefined,
        displayName: name,
        clientId: getClientId(),
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error ?? 'Could not join room');
      if (data.retryAfterSec) setRetry(data.retryAfterSec);
    } else {
      saveDisplayName(name);
      saveRoomSession(id, {
        sessionToken: data.sessionToken,
        ticket: data.ticket,
        hasPasscode: data.hasPasscode,
      });
      nav(`/r/${id}`);
    }
    setBusy(false);
  };
  return (
    <Shell>
      <FormPage
        eyebrow="TAKE A SEAT"
        title={
          id ? (
            <>
              Enter <em>{id}</em>
            </>
          ) : (
            <>
              Choose a room
              <br />
              <em>from a link.</em>
            </>
          )
        }
      >
        <form onSubmit={submit} className="form-stack">
          {!actual && (
            <Input
              label="ROOM ID"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="room-id"
              required
            />
          )}
          <Input
            label="DISPLAY NAME"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          {id && <PasscodeField value={passcode} onChange={(e) => setPasscode(e.target.value)} />}
          {error && (
            <div className="form-error">
              {error}
              {retry ? ` · try again in ${retry}s` : ''}
            </div>
          )}
          <Button type="submit" disabled={busy || !id || !!retry}>
            {busy ? 'CHECKING…' : 'ENTER ROOM'}
          </Button>
        </form>
      </FormPage>
    </Shell>
  );
}
function FormPage({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="form-page">
      <Link to="/" className="back-link">
        ← LOBBY
      </Link>
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      {children}
    </div>
  );
}
function WorkspaceRoute() {
  const { roomId = '' } = useParams();
  return <Workspace roomId={roomId} />;
}
function Workspace({ roomId }: { roomId: string }) {
  const nav = useNavigate();
  const session = getRoomSession(roomId);
  const [ticket, setTicket] = useState(session?.ticket);
  const [language, setLanguage] = useState<RoomLanguage>('plaintext');
  const [readonly, setReadonly] = useState(false);
  const [toast, setToast] = useState('');
  const [left, setLeft] = useState(paneSizes().leftWidth ?? 260);
  const [right, setRight] = useState(paneSizes().rightWidth ?? 320);
  const [feed, setFeed] = useState<any[]>([]);
  const provider = useMemo(
    () =>
      ticket ? new CarrelProvider(`${wsBase()}/ws?ticket=${encodeURIComponent(ticket)}`) : null,
    [ticket],
  );
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
    if (!session && !ticket) nav(`/join/${roomId}`, { replace: true });
  }, [session, ticket, nav, roomId]);
  useEffect(() => {
    if (!provider) return;
    const a = provider.on('roster', (p) => setUI({ roster: p.members }));
    const b = provider.on('room_updated', (p) => {
      setLanguage(p.language as RoomLanguage);
      setReadonly(p.readonly);
    });
    const c = provider.on('audit', (e) => setFeed((items) => [e, ...items].slice(0, 30)));
    const d = provider.on('kicked', () => nav(`/join/${roomId}`));
    const e = provider.on('error', (x) => setToast(x.code));
    return () => {
      a();
      b();
      c();
      d();
      e();
      provider.destroy();
    };
  }, [provider, nav, roomId, setUI]);
  if (!ticket)
    return (
      <Shell>
        <div className="empty-state">
          <Panel label="ROOM ACCESS">
            <p>Session expired. Take a seat again.</p>
            <Link className="btn primary md" to={`/join/${roomId}`}>
              JOIN ROOM
            </Link>
          </Panel>
        </div>
      </Shell>
    );
  const activeProvider = provider!;
  const host = roster.find((member) => member.id === user.id)?.role === 'host';
  const invite = `${window.location.origin}/join/${roomId}`;
  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).then(() => setToast('Copied'));
  const send = (message: Record<string, unknown>) => provider?.sendControl(message);
  const setPane = (side: 'left' | 'right', value: number) => {
    const next =
      side === 'left' ? Math.max(240, Math.min(420, value)) : Math.max(280, Math.min(480, value));
    if (side === 'left') setLeft(next);
    else setRight(next);
    savePaneSizes(side === 'left' ? next : left, side === 'right' ? next : right);
  };
  return (
    <Shell>
      <div className="workspace">
        <header className="workspace-top">
          <div>
            <span className="eyebrow">ROOM</span>
            <button className="room-id mono-label" onClick={() => copy(roomId)}>
              {roomId} <Copy size={13} />
            </button>
          </div>
          <div className="workspace-actions">
            <ConnectionLight reconnecting={activeProvider.status !== 'synced'} />
            <span className="mono-label">{activeProvider.status}</span>
            <Badge tone={host ? 'accent' : 'neutral'}>{host ? 'HOST' : 'MEMBER'}</Badge>
            <Select
              aria-label="Language"
              value={language}
              disabled={!host}
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
              {host && (
                <Button
                  size="sm"
                  variant="secondary"
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
                    host={host}
                    onKick={() => send({ type: 'kick', clientId: person.id })}
                    onMakeHost={() => send({ type: 'make_host', clientId: person.id })}
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
              <CarrelEditor
                provider={activeProvider}
                language={language}
                readOnly={readonly && !host}
                onInput={() => undefined}
              />
            </div>
            <div className="statusbar">
              <span>Ln 1 / Col 1</span>
              <span>{labels[language]}</span>
              <span>{roster.length} peers</span>
              <span>{readonly ? 'READ-ONLY' : activeProvider.status.toUpperCase()}</span>
            </div>
          </section>
          <aside className="activity-pane">
            <ResizeControl value={right} onChange={(v) => setPane('right', v)} />
            <Panel label="ACTIVITY">
              <div className="activity-list">
                {feed.length ? (
                  feed.map((event, index) => (
                    <ListRow key={`${event.event}-${index}`}>
                      <Activity size={14} />
                      <span>
                        <strong>{event.event}</strong>
                        <small>{event.actorId?.slice(0, 8)}</small>
                      </span>
                    </ListRow>
                  ))
                ) : (
                  <div className="empty-presence">Audit events will appear here.</div>
                )}
              </div>
            </Panel>
          </aside>
        </div>
        <nav className="bottom-tabs">
          <button onClick={() => setUI({ activeTab: 'editor' })}>Editor</button>
          <button onClick={() => setUI({ activeTab: 'people' })}>People</button>
          <button onClick={() => setUI({ activeTab: 'activity' })}>Activity</button>
        </nav>
      </div>
      <Toast message={toast} open={!!toast} onClose={() => setToast('')} />
    </Shell>
  );
}
function Participant({
  person,
  state,
  you,
  host,
  onKick,
  onMakeHost,
}: {
  person: RosterMember;
  state?: PresenceState;
  you: boolean;
  host: boolean;
  onKick: () => void;
  onMakeHost: () => void;
}) {
  const status = state?.status ?? 'active';
  return (
    <ListRow>
      <Avatar name={person.name} color={person.color} />
      <span className="participant-copy">
        <strong>
          {person.name} {you && <Badge>YOU</Badge>}
        </strong>
        <small>
          {person.role === 'host' && (
            <span className="host-tag">
              <Crown size={11} /> HOST
            </span>
          )}
        </small>
      </span>
      <StatusBadge status={(status[0].toUpperCase() + status.slice(1)) as any} />
      {host && !you && (
        <span className="row-actions">
          <button onClick={onMakeHost}>host</button>
          <button onClick={onKick}>×</button>
        </span>
      )}
    </ListRow>
  );
}
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
export default function App() {
  return (
    <AppErrorBoundary>
      <Routes>
        <Route path="/tokens" element={<TokensPage />} />
        <Route path="/" element={<Lobby />} />
        <Route path="/create" element={<CreateRoom />} />
        <Route path="/join/:roomId" element={<JoinRoom />} />
        <Route path="/r/:roomId" element={<WorkspaceRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppErrorBoundary>
  );
}

class AppErrorBoundary extends React.Component<React.PropsWithChildren, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  render() {
    return this.state.error ? (
      <Shell>
        <div className="empty-state">
          <Panel label="WORKSPACE ERROR">
            <p>{this.state.error}</p>
            <Link className="btn secondary md" to="/">
              RETURN TO LOBBY
            </Link>
          </Panel>
        </div>
      </Shell>
    ) : (
      this.props.children
    );
  }
}

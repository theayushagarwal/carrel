import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Input, PasscodeField } from '../ui';
import {
  apiBase,
  getClientId,
  getDisplayName,
  saveDisplayName,
  saveRoomSession,
} from '../collab/storage';

const api = (path: string, init?: RequestInit) =>
  fetch(`${apiBase()}${path}`, { headers: { 'content-type': 'application/json' }, ...init });

const WORDS_A = [
  'quiet',
  'silent',
  'amber',
  'cedar',
  'paper',
  'night',
  'stone',
  'brass',
  'dijkstra',
  'turing',
];
const WORDS_B = [
  'study',
  'notes',
  'carrel',
  'folio',
  'desk',
  'reader',
  'script',
  'index',
  'draft',
  'log',
];

function generateRoomId(): string {
  const a = WORDS_A[Math.floor(Math.random() * WORDS_A.length)];
  const b = WORDS_B[Math.floor(Math.random() * WORDS_B.length)];
  const num = Math.floor(Math.random() * 90 + 10);
  return `${a}-${b}-${num}`;
}

export function CreateRoomPage() {
  const nav = useNavigate();
  const [id, setId] = useState('');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [passcode, setPasscode] = useState('');
  const [name, setName] = useState(getDisplayName());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [flapping, setFlapping] = useState(false);
  const [flapChars, setFlapChars] = useState<string[]>([]);
  const [announceText, setAnnounceText] = useState('');

  useEffect(() => {
    if (!id) {
      setAvailable(null);
      return;
    }
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

  const handleGenerate = () => {
    const nextId = generateRoomId();
    setFlapChars(nextId.split(''));
    setFlapping(true);
    setAnnounceText(`Generated room ID ${nextId}`);

    // End flapping animation after stagger
    const totalDuration = nextId.length * 35 + 240;
    setTimeout(() => {
      setId(nextId);
      setFlapping(false);
    }, totalDuration);
  };

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
    if (!response.ok) {
      setError(data.error ?? 'Could not create room');
    } else {
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
    <div className="create-page-layout">
      {/* Visually hidden announcement for screen readers */}
      <div className="sr-only" aria-live="polite">
        {announceText}
      </div>

      <div className="create-form-column">
        <Link to="/" className="back-link">
          ← LOBBY
        </Link>
        <span className="eyebrow">RESERVE A ROOM</span>
        <h1 className="create-page-title">
          Make a room
          <br />
          <em>worth returning to.</em>
        </h1>
        <p className="create-page-lede">
          A persistent collaborative space. Choose an identifier or let the library assign one.
        </p>

        <form onSubmit={submit} className="create-room-form form-stack">
          <div className="room-id-field-group">
            <div className="inline-field">
              {flapping ? (
                <div className="flap-display-wrap" aria-hidden="true" data-testid="flap-display">
                  <span className="mono-label field-header">ROOM ID</span>
                  <div className="flap-track">
                    {flapChars.map((ch, idx) => (
                      <span
                        key={idx}
                        className="flap-cell"
                        style={{ animationDelay: `${idx * 35}ms` }}
                      >
                        {ch}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <Input
                  label="ROOM ID"
                  value={id}
                  onChange={(e) => setId(e.target.value.toLowerCase())}
                  placeholder="dijkstra-notes"
                  hint="3–32 lowercase letters, digits, hyphens"
                />
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleGenerate}
                aria-label="Generate identifier"
                data-testid="generate-btn"
              >
                GENERATE
              </Button>
            </div>

            {/* Inked Status Stamp */}
            {available !== null && id.length >= 3 && (
              <div
                className={`inked-stamp ${available ? 'stamp-available' : 'stamp-taken'}`}
                data-testid="room-stamp"
                role="status"
              >
                {available ? 'AVAILABLE' : 'TAKEN'}
              </div>
            )}
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
            placeholder="Alice"
            required
          />

          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}

          <Button type="submit" disabled={busy || !name} data-testid="reserve-submit-btn">
            {busy ? 'CREATING…' : 'RESERVE ROOM'}
          </Button>
        </form>
      </div>

      {/* Asymmetric Ticket Preview Column */}
      <aside className="create-preview-column" aria-label="Ticket preview">
        <div className="ticket-card-sheen" data-testid="ticket-preview">
          <div className="ticket-header">
            <span className="mono-label">CARREL // TICKET PREVIEW</span>
            <span className="ticket-badge">HMAC-SHA256</span>
          </div>
          <div className="ticket-divider" />
          <div className="ticket-meta-grid">
            <div className="ticket-meta-row">
              <span className="mono-label label-col">TARGET ROOM</span>
              <span className="mono-label val-col room-name-val">{id || 'unassigned'}</span>
            </div>
            <div className="ticket-meta-row">
              <span className="mono-label label-col">RESERVED FOR</span>
              <span className="mono-label val-col">{name || 'Guest'}</span>
            </div>
            <div className="ticket-meta-row">
              <span className="mono-label label-col">PROTECTION</span>
              <span className="mono-label val-col">
                {passcode ? 'Passcode enabled (scrypt)' : 'Open access'}
              </span>
            </div>
            <div className="ticket-meta-row">
              <span className="mono-label label-col">ROLE</span>
              <span className="mono-label val-col accent-val">ROOM CREATOR / HOST</span>
            </div>
          </div>
          <div className="ticket-footer">
            <span className="ticket-hash mono-label">
              NONCE: {Math.random().toString(36).slice(2, 10).toUpperCase()}
            </span>
            <span className="ticket-ttl mono-label">TTL: 60s single-use</span>
          </div>
        </div>
      </aside>
    </div>
  );
}

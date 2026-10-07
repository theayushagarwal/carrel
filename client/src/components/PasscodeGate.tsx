import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Input, PasscodeField } from '../ui';
import {
  apiBase,
  getClientId,
  getDisplayName,
  getRoomSession,
  saveDisplayName,
  saveRoomSession,
} from '../collab/storage';
import { useReducedMotion } from '../hooks/useReducedMotion';

const api = (path: string, init?: RequestInit) =>
  fetch(`${apiBase()}${path}`, { headers: { 'content-type': 'application/json' }, ...init });

export function PasscodeGatePage() {
  const nav = useNavigate();
  const { roomId = '' } = useParams();
  const actualRoomId = roomId === 'new' ? '' : roomId;
  const reducedMotion = useReducedMotion();

  const [id, setId] = useState(actualRoomId);
  const [name, setName] = useState(getDisplayName() || 'Guest');
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // Padlock & door transition states
  const [padlockShake, setPadlockShake] = useState(false);
  const [shackleOpen, setShackleOpen] = useState(false);
  const [doorSwingActive, setDoorSwingActive] = useState(false);

  // If already holding a valid session token, skip gate immediately
  useEffect(() => {
    if (!actualRoomId) return;
    const existing = getRoomSession(actualRoomId);
    if (existing?.sessionToken) {
      nav(`/r/${actualRoomId}`, { replace: true });
    }
  }, [actualRoomId, nav]);

  // Countdown timer for lockout
  useEffect(() => {
    if (!retry) return;
    const timer = setInterval(() => setRetry((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(timer);
  }, [retry]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (retry > 0) return;

    setBusy(true);
    setError('');

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
      if (response.status === 429 || data.retryAfterSec) {
        setRetry(data.retryAfterSec ?? 15);
        setError(`Locked out. Try again in ${data.retryAfterSec ?? 15}s.`);
      } else if (response.status === 401) {
        // Wrong passcode
        setAttemptsLeft((prev) => (prev === null ? 3 : Math.max(0, prev - 1)));
        const rem = attemptsLeft !== null ? attemptsLeft - 1 : 3;
        setError(`Wrong passcode. ${rem > 0 ? `${rem} tries left.` : 'Lockout imminent.'}`);

        if (!reducedMotion) {
          setPadlockShake(true);
          setTimeout(() => setPadlockShake(false), 340);
        }
      } else {
        setError(data.error ?? 'Could not join room');
      }
      setBusy(false);
      return;
    }

    // Success: save session
    saveDisplayName(name);
    saveRoomSession(id, {
      sessionToken: data.sessionToken,
      ticket: data.ticket,
      hasPasscode: data.hasPasscode,
    });

    if (reducedMotion || !passcode) {
      // Directly navigate without 3D animation
      nav(`/r/${id}`);
      return;
    }

    // Play Shackle Lift & Door Swing choreography
    setShackleOpen(true);
    setTimeout(() => {
      setDoorSwingActive(true);
    }, 320);

    setTimeout(() => {
      nav(`/r/${id}`);
    }, 980);
  };

  const isLockedOut = retry > 0;

  return (
    <div className="passcode-gate-layout">
      {/* Door Swing Transition Overlay */}
      {doorSwingActive && (
        <div
          className="door-swing-overlay"
          data-testid="door-swing-transition"
          aria-hidden="true"
        />
      )}

      <div className="gate-form-panel">
        <Link to="/" className="back-link">
          ← LOBBY
        </Link>
        <span className="eyebrow">TAKE A SEAT</span>
        <h1 className="gate-title">
          {actualRoomId ? (
            <>
              Enter <em>{actualRoomId}</em>
            </>
          ) : (
            <>
              Choose a room
              <br />
              <em>from a link.</em>
            </>
          )}
        </h1>

        <form onSubmit={submit} className="form-stack">
          {!actualRoomId && (
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
            placeholder="Priya"
            required
            disabled={busy || isLockedOut}
          />

          {actualRoomId && (
            <PasscodeField
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              disabled={busy || isLockedOut}
            />
          )}

          {error && (
            <div className="form-error" role="alert" data-testid="gate-error">
              {error}
            </div>
          )}

          {isLockedOut && (
            <div
              className="lockout-countdown mono-label"
              data-testid="lockout-countdown"
              role="status"
            >
              Locked out. Retry in {retry}s
            </div>
          )}

          <Button type="submit" disabled={busy || !id || isLockedOut} data-testid="gate-submit-btn">
            {busy ? 'CHECKING…' : isLockedOut ? `LOCKED (${retry}S)` : 'ENTER ROOM'}
          </Button>
        </form>
      </div>

      {/* Layered CSS 3D Padlock Object */}
      <div className="gate-padlock-stage" aria-hidden="true">
        <div
          className={`padlock-3d ${padlockShake ? 'padlock-shake' : ''} ${
            isLockedOut ? 'padlock-dimmed' : ''
          } ${reducedMotion ? 'reduced-motion' : ''}`}
          data-testid="css-padlock"
        >
          {/* Shackle */}
          <div className={`padlock-shackle ${shackleOpen ? 'shackle-open' : ''}`}>
            <div className="shackle-left" />
            <div className="shackle-arch" />
            <div className="shackle-right" />
          </div>

          {/* Solid Brass Body */}
          <div className="padlock-body">
            <div className="padlock-inner-bevel">
              <div className="padlock-keyhole-plate">
                <div className="keyhole-hole" />
                <div className="keyhole-stem" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

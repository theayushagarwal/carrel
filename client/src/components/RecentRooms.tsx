import React, { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RecentRoom } from '../collab/storage';
import { useReducedMotion } from '../hooks/useReducedMotion';

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return 'recently';
  const now = Date.now();
  const diffSec = Math.floor((now - timestamp) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 30) return `${diffDays} days ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

function LockIcon() {
  return (
    <svg
      width="13"
      height="14"
      viewBox="0 0 13 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Passcode required"
      className="card-padlock-icon"
    >
      <rect x="2" y="6" width="9" height="7" rx="1.5" />
      <path d="M4 6V4a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

function TiltCard({ room }: { room: RecentRoom }) {
  const cardRef = useRef<HTMLAnchorElement>(null);
  const reducedMotion = useReducedMotion();
  const [coords, setCoords] = useState<{ x: number; y: number; rotX: number; rotY: number }>({
    x: 50,
    y: 50,
    rotX: 0,
    rotY: 0,
  });
  const [isHovered, setIsHovered] = useState(false);

  const handlePointerMove = (e: React.PointerEvent<HTMLAnchorElement>) => {
    if (reducedMotion || window.innerWidth < 768) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 100;
    const py = ((e.clientY - rect.top) / rect.height) * 100;

    // +-8 degrees rotation
    const nx = (px / 100) * 2 - 1;
    const ny = (py / 100) * 2 - 1;
    const rotX = -ny * 8;
    const rotY = nx * 8;

    setCoords({ x: px, y: py, rotX, rotY });
  };

  const handlePointerEnter = () => setIsHovered(true);
  const handlePointerLeave = () => {
    setIsHovered(false);
    setCoords({ x: 50, y: 50, rotX: 0, rotY: 0 });
  };

  const transformStyle =
    !reducedMotion && isHovered
      ? `perspective(1200px) rotateX(${coords.rotX}deg) rotateY(${coords.rotY}deg) translateZ(8px)`
      : 'perspective(1200px) rotateX(0deg) rotateY(0deg) translateZ(0px)';

  return (
    <Link
      ref={cardRef}
      to={`/r/${room.id}`}
      className="recent-tilt-card recent-card"
      onPointerMove={handlePointerMove}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      data-testid="recent-room-card"
      style={{
        transform: transformStyle,
        ['--mouse-x' as any]: `${coords.x}%`,
        ['--mouse-y' as any]: `${coords.y}%`,
      }}
    >
      <div className="card-sheen-layer" aria-hidden="true" />
      <div className="card-body">
        <div className="card-top-row">
          <span className="mono-label room-id-tag">{room.id}</span>
          {room.hasPasscode && <LockIcon />}
        </div>
        <h3 className="card-title">{room.id.replace(/-/g, ' ')}</h3>
        <div className="card-footer-row">
          <span className="tabular-time mono-label">
            last here {formatRelativeTime(room.lastVisited)}
          </span>
          <span className="access-label">{room.hasPasscode ? 'passcode' : 'open'}</span>
        </div>
      </div>
    </Link>
  );
}

export function RecentRooms({ rooms }: { rooms: RecentRoom[] }) {
  if (rooms.length === 0) {
    return (
      <section className="recent-rooms-section" aria-label="Recent rooms">
        <div className="empty-recent-state" data-testid="empty-recent-rooms">
          <span className="eyebrow">YOUR DESK</span>
          <h2 className="empty-recent-title">No recent rooms yet.</h2>
          <p className="empty-recent-copy">
            Rooms you create or join will appear here on your local machine.
          </p>
          <div className="empty-recent-action">
            <Link to="/create" className="btn secondary sm">
              RESERVE A ROOM
            </Link>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="recent-rooms-section" aria-label="Recent rooms">
      <div className="recent-rooms-header">
        <span className="eyebrow">RECENT ROOMS</span>
        <span className="mono-label count-label">{rooms.length} saved</span>
      </div>
      <div className="recent-cards-grid" data-testid="recent-cards-grid">
        {rooms.map((room) => (
          <TiltCard key={room.id} room={room} />
        ))}
      </div>
    </section>
  );
}

import React, { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Nib } from '../icons';

export function Shell({ children }: { children: ReactNode }) {
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
        <span className="mono-label">A QUIET WORKSPACE</span>
      </header>
      {children}
    </main>
  );
}

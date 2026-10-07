import React, { useEffect, useState } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { Panel } from './ui';
import { getRecentRooms } from './collab/storage';
import { LobbySvgFallback } from './components/LobbySvgFallback';
import { RecentRooms } from './components/RecentRooms';
import { CreateRoomPage } from './components/CreateRoom';
import { PasscodeGatePage } from './components/PasscodeGate';
import { Shell } from './components/Shell';

const LazyLobbyScene = React.lazy(() => import('./components/LobbyScene'));
const TokensPage = React.lazy(() => import('./TokensPage'));
const WorkspaceRoute = React.lazy(() => import('./WorkspaceRoute'));

function Lobby() {
  const recent = getRecentRooms();
  const [shouldLoadScene, setShouldLoadScene] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if ('requestIdleCallback' in window) {
      const handle = (window as any).requestIdleCallback(() => setShouldLoadScene(true), {
        timeout: 800,
      });
      return () => (window as any).cancelIdleCallback(handle);
    } else {
      const timer = setTimeout(() => setShouldLoadScene(true), 250);
      return () => clearTimeout(timer);
    }
  }, []);

  return (
    <Shell>
      <div className="lobby-layout">
        <div className="lobby-hero-column">
          <span className="eyebrow">A QUIET PLACE TO WORK TOGETHER</span>
          <h1 className="lobby-hero-title">
            Take a seat.
            <br />
            <em>Make a mark.</em>
          </h1>
          <p className="lobby-lede">
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
        </div>
        <div className="lobby-scene-column">
          <React.Suspense fallback={<LobbySvgFallback />}>
            {shouldLoadScene ? <LazyLobbyScene /> : <LobbySvgFallback />}
          </React.Suspense>
        </div>
      </div>

      <RecentRooms rooms={recent} />

      <footer className="lobby-footer">
        <span>Carrel · A quiet real-time workspace. No tracking, no marketing cookies.</span>
      </footer>
    </Shell>
  );
}

function CreateRoom() {
  return (
    <Shell>
      <CreateRoomPage />
    </Shell>
  );
}

function JoinRoom() {
  return (
    <Shell>
      <PasscodeGatePage />
    </Shell>
  );
}

function NotFoundScreen() {
  return (
    <Shell>
      <div className="empty-state" data-testid="screen-404">
        <Panel label="404 / NOT FOUND">
          <h2 className="error-title">Desk not found.</h2>
          <p>The carrel you are looking for has been moved or retired from the floor.</p>
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

export default function App() {
  return (
    <AppErrorBoundary>
      <React.Suspense fallback={<div className="loading-screen" />}>
        <Routes>
          <Route path="/tokens" element={<TokensPage />} />
          <Route path="/" element={<Lobby />} />
          <Route path="/create" element={<CreateRoom />} />
          <Route path="/join/:roomId" element={<JoinRoom />} />
          <Route path="/r/:roomId" element={<WorkspaceRoute />} />
          <Route path="*" element={<NotFoundScreen />} />
        </Routes>
      </React.Suspense>
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

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { participantColors, readableTextOn } from '@carrel/shared';
import * as Icons from './icons';
import { Avatar, Button, Input, Panel, StatusBadge, Toast, Toggle } from './ui';

type Status = 'Typing' | 'Active' | 'Idle' | 'Away' | 'Reconnecting';
const swatches = [
  ['ink-950', 'var(--ink-950)', 'app background'],
  ['ink-900', 'var(--ink-900)', 'panels'],
  ['ink-850', 'var(--ink-850)', 'raised surfaces'],
  ['ink-700', 'var(--ink-700)', 'hairline borders'],
  ['ink-500', 'var(--ink-500)', 'muted / disabled'],
  ['paper-300', 'var(--paper-300)', 'secondary text'],
  ['paper-100', 'var(--paper-100)', 'primary text'],
  ['brass-500', 'var(--brass-500)', 'accent / focus'],
  ['verdigris-500', 'var(--verdigris-500)', 'online / synced'],
  ['madder-500', 'var(--madder-500)', 'error / destructive'],
];
const statuses: Status[] = ['Typing', 'Active', 'Idle', 'Away', 'Reconnecting'];
const iconSet = [
  Icons.Crown,
  Icons.Lock,
  Icons.LockOpen,
  Icons.Door,
  Icons.Nib,
  Icons.Pin,
  Icons.Copy,
  Icons.Check,
  Icons.Close,
  Icons.Plus,
  Icons.User,
  Icons.Users,
  Icons.Activity,
  Icons.Code,
  Icons.Sun,
  Icons.Moon,
  Icons.Wifi,
  Icons.WifiOff,
  Icons.Chevron,
  Icons.LinkIcon,
  Icons.Alert,
  Icons.Refresh,
  Icons.Resize,
  Icons.Kick,
];
const iconNames = [
  'crown',
  'padlock-closed',
  'padlock-open',
  'door',
  'nib',
  'pin',
  'copy',
  'check',
  'close',
  'plus',
  'user',
  'users',
  'activity',
  'code',
  'sun',
  'moon',
  'wifi',
  'wifi-off',
  'chevron',
  'link',
  'alert',
  'refresh',
  'resize-handle',
  'kick',
];

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-heading">
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}
function App() {
  const [theme, setTheme] = useState<'dark' | 'paper'>('dark');
  const [grid, setGrid] = useState(false);
  const [toast, setToast] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'paper' ? 'paper' : '';
    document.body.classList.toggle('show-grid', grid);
  }, [theme, grid]);
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Icons.Nib size={18} />
          </span>
          <span>CARREL</span>
          <span className="brand-slash">/</span>
          <span className="brand-muted">TOKENS</span>
        </div>
        <div className="top-actions">
          <span className="mono-label">FOUNDATION // 01</span>
          <Toggle
            checked={theme === 'paper'}
            onChange={() => setTheme(theme === 'dark' ? 'paper' : 'dark')}
            label={theme === 'dark' ? 'Paper theme' : 'Dark theme'}
          />
          <Toggle checked={grid} onChange={() => setGrid(!grid)} label="Baseline grid" />
        </div>
      </header>
      <div className="page-grid">
        <aside className="rail">
          <div className="rail-title">ON THIS PAGE</div>
          <nav>
            <a className="active" href="#colors">
              01 / Color
            </a>
            <a href="#type">02 / Type</a>
            <a href="#shape">03 / Shape</a>
            <a href="#icons">04 / Icons</a>
            <a href="#components">05 / Components</a>
            <a href="#motion">06 / Motion</a>
          </nav>
          <div className="rail-note">
            <span className="status status-active">
              <i />
              Synced
            </span>
            <p>Design system specimen. Plain, specific, slightly dry.</p>
          </div>
        </aside>
        <div className="content">
          <div className="intro">
            <span className="eyebrow">CARREL.UI / DESIGN SYSTEM</span>
            <h1>
              Tokens for a room
              <br />
              <em>worth staying in.</em>
            </h1>
            <p>
              Warm, tactile foundations for a real-time study workspace. Dark by default. Paper when
              the lamp is on.
            </p>
          </div>
          <Section eyebrow="01 / COLOR" title="Ink, paper, brass">
            <div id="colors" className="swatch-grid">
              {swatches.map(([name, hex, use]) => (
                <div className="swatch" key={name}>
                  <div className="swatch-color" style={{ background: hex }}>
                    <span style={{ color: readableTextOn(hex) }}>{hex}</span>
                  </div>
                  <div className="swatch-name">--{name}</div>
                  <div className="swatch-use">{use}</div>
                </div>
              ))}
            </div>
            <div className="participant-row">
              <span className="eyebrow">PARTICIPANT COLORS / 8</span>
              {participantColors.map((color) => (
                <span
                  key={color}
                  className="participant-dot"
                  style={{ background: color }}
                  title={`${color} · readable ${readableTextOn(color)}`}
                />
              ))}
            </div>
          </Section>
          <Section eyebrow="02 / TYPE" title="Three voices, one room">
            <div id="type" className="type-grid">
              <div>
                <span className="eyebrow">FRAUNCES / HEADINGS</span>
                <div className="type-display">
                  The quiet
                  <br />
                  work matters.
                </div>
                <span className="type-meta">opsz + SOFT axes · 72 / 40 / 24</span>
              </div>
              <div>
                <span className="eyebrow">INSTRUMENT SANS / UI</span>
                <div className="type-ui">A clear interface makes room for thought.</div>
                <div className="type-ui small">Buttons · Inputs · Labels · Status</div>
                <span className="type-meta">400 / 500 / 600 · 18 / 15 / 13</span>
              </div>
              <div>
                <span className="eyebrow">IBM PLEX MONO / SYSTEM</span>
                <div className="type-mono">
                  ROOM_04 / SYNCED
                  <br />
                  22:47:08 / 3 PARTICIPANTS
                </div>
                <span className="type-meta">11 / 12px · tabular numerals</span>
              </div>
            </div>
          </Section>
          <Section eyebrow="03 / SHAPE + DEPTH" title="Edges, not blobs">
            <div id="shape" className="shape-grid">
              <div className="shape-sample radius-2">
                <span>2px radius</span>
                <b>Hairline</b>
              </div>
              <div className="shape-sample radius-4">
                <span>4px radius</span>
                <b>Panel</b>
              </div>
              <div className="shape-sample radius-8">
                <span>8px radius</span>
                <b>Raised surface</b>
              </div>
              <div className="shadow-sample">
                <span>shadow token</span>
                <b>0 8px 24px -12px</b>
              </div>
            </div>
          </Section>
          <Section eyebrow="04 / ICONS" title="Small marks, drawn by hand">
            <div id="icons" className="icon-grid">
              {iconSet.map((Icon, i) => (
                <div className="icon-cell" key={iconNames[i]}>
                  <Icon size={20} />
                  <span>{iconNames[i]}</span>
                </div>
              ))}
            </div>
          </Section>
          <Section eyebrow="05 / COMPONENTS" title="Every state earns its name">
            <div id="components" className="component-grid">
              <div className="component-column">
                <span className="eyebrow">BUTTONS</span>
                <div className="button-row">
                  <Button variant="primary">Open room</Button>
                  <Button variant="secondary">Copy link</Button>
                  <Button variant="ghost">Cancel</Button>
                  <Button variant="danger">Kick</Button>
                </div>
                <span className="eyebrow">STATUS</span>
                <div className="status-row">
                  {statuses.map((s) => (
                    <StatusBadge key={s} status={s} />
                  ))}
                </div>
              </div>
              <div className="component-column">
                <span className="eyebrow">INPUTS</span>
                <label className="field-label">
                  ROOM PASSCODE
                  <Input placeholder="Enter four words" aria-label="Room passcode" />
                </label>
                <Input
                  className="error"
                  value="wrong-passcode"
                  readOnly
                  label="WITH ERROR"
                  error="That passcode does not match this room."
                />
              </div>
              <div className="component-column">
                <span className="eyebrow">PANEL</span>
                <Panel label="ROOM ACTIVITY · LIVE">
                  <div className="panel-row">
                    <Avatar name="Mae" color={participantColors[0]} />
                    <span>Mae is typing</span>
                    <StatusBadge status="Typing" />
                  </div>
                  <div className="panel-row">
                    <Avatar name="Rafi" color={participantColors[1]} />
                    <span>Rafi joined</span>
                    <StatusBadge status="Active" />
                  </div>
                </Panel>
              </div>
            </div>
          </Section>
          <Section eyebrow="06 / MOTION" title="A measured pulse">
            <div id="motion" className="motion-grid">
              <div className="motion-demo">
                <div className="waveform">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
                <span>Typing waveform · 8Hz</span>
              </div>
              <div className="motion-demo">
                <motion.div
                  className="coin"
                  animate={{ rotateY: [0, 180, 360] }}
                  transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
                >
                  C
                </motion.div>
                <span>Avatar coin-flip · spring</span>
              </div>
              <div className="motion-demo">
                <div className="ease-line">
                  <b className="ease-dot" />
                </div>
                <span>ease-out · 0.22, 1, 0.36, 1</span>
              </div>
            </div>
          </Section>
          <footer className="footer">
            <span>CARREL / PHASE 1</span>
            <span>TYPE SAFE · FOCUS READY · NO GLOW</span>
            <button
              className="toast-trigger"
              onClick={() => {
                setToast(true);
                setTimeout(() => setToast(false), 2200);
              }}
            >
              <Icons.Check size={14} /> Test toast
            </button>
          </footer>
        </div>
      </div>
      <div className="grain" />
      <Toast
        message="Changes are local to this specimen."
        open={toast}
        onClose={() => setToast(false)}
      />
    </main>
  );
}
export default App;

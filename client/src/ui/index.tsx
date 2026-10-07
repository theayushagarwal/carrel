import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { motion } from 'framer-motion';
import { durations, spring } from '../motion';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { Check, Close, Crown, Eye, EyeOff, Resize, Sun, Moon } from '../icons';

export function Button({
  variant = 'primary',
  size = 'md',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}) {
  return (
    <button className={`btn ${variant} ${size}`} {...props}>
      {children}
    </button>
  );
}
export function Input(
  props: InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; error?: string },
) {
  const { label, hint, error, ...input } = props;
  return (
    <label className="field-label">
      {label}
      <input className={`input ${error ? 'error' : ''}`} {...input} />
      {error ? (
        <span className="field-error">{error}</span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </label>
  );
}
export function PasscodeField(props: InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  const [visible, setVisible] = useState(false);
  const { label = 'PASSCODE', ...input } = props;
  return (
    <label className="field-label">
      {label}
      <span className="passcode-wrap">
        <input className="input" type={visible ? 'text' : 'password'} {...input} />
        <button
          type="button"
          className="input-action"
          onClick={() => setVisible(!visible)}
          aria-label={visible ? 'Hide passcode' : 'Show passcode'}
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </span>
    </label>
  );
}
export function Select({
  label,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  return (
    <label className="field-label">
      {label}
      <select className="input" {...props}>
        {children}
      </select>
    </label>
  );
}
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      className={`toggle ${checked ? 'is-on' : ''}`}
      onClick={onChange}
      aria-pressed={checked}
    >
      <span className="toggle-knob" />
      {label}
    </button>
  );
}
export function Badge({
  children,
  tone = 'neutral',
  ...props
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'good' | 'bad';
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={`badge badge-${tone}`} {...props}>
      {children}
    </span>
  );
}
export type Status = 'Typing' | 'Active' | 'Idle' | 'Away' | 'Reconnecting';
export function StatusBadge({ status }: { status: Status }) {
  const reduced = useReducedMotion();
  return (
    <span className={`status status-${status.toLowerCase()}`} aria-label={`Status: ${status}`}>
      {status === 'Typing' ? (
        <span className={`typing-waveform ${reduced ? 'reduced' : ''}`} aria-hidden="true">
          <span className="wave-bar wave-bar-1" />
          <span className="wave-bar wave-bar-2" />
          <span className="wave-bar wave-bar-3" />
        </span>
      ) : (
        <i />
      )}
      {status}
    </span>
  );
}
export function Avatar({ name, color }: { name: string; color: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.span
      className="avatar"
      style={{ background: color }}
      initial={reduced ? false : { rotateY: 180 }}
      animate={{ rotateY: 0 }}
      transition={reduced ? { duration: durations.instant / 1000 } : spring}
    >
      {name.slice(0, 1).toUpperCase()}
    </motion.span>
  );
}
export function HostCrownTag({
  flip = false,
  dimmed = false,
}: {
  flip?: boolean;
  dimmed?: boolean;
} = {}) {
  const reduced = useReducedMotion();
  return (
    <motion.span
      className={`host-crown-wrap ${dimmed ? 'crown-dimmed' : ''}`}
      data-testid="host-crown-tag"
      initial={flip ? (reduced ? { opacity: 0 } : { rotateY: 0 }) : false}
      animate={flip ? (reduced ? { opacity: 1 } : { rotateY: 360 }) : undefined}
      transition={{ duration: 0.35, ease: [0.34, 1.56, 0.64, 1] }}
      style={{ display: 'inline-flex' }}
    >
      <Badge tone={dimmed ? 'neutral' : 'accent'}>
        <Crown size={12} /> HOST
      </Badge>
    </motion.span>
  );
}
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return <span title={label}>{children}</span>;
}
export function Toast({
  message,
  open,
  onClose,
}: {
  message: string;
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(onClose, durations.slow);
    return () => clearTimeout(timer);
  }, [open, onClose]);
  return open ? (
    <div className="toast" role="status">
      <Check size={16} />
      <span>{message}</span>
      <button onClick={onClose} aria-label="Close toast">
        <Close size={14} />
      </button>
    </div>
  ) : null;
}
export function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="panel">
      <div className="panel-head">{label}</div>
      {children}
    </div>
  );
}
export function Divider() {
  return <hr className="divider" />;
}
export type ConnectionStatus = 'synced' | 'connecting' | 'reconnecting' | 'offline' | 'closed';

export function ConnectionLight({
  status,
  reconnecting,
  'data-testid': testId,
}: {
  status?: ConnectionStatus;
  reconnecting?: boolean;
  'data-testid'?: string;
}) {
  const currentStatus: ConnectionStatus = status ?? (reconnecting ? 'reconnecting' : 'synced');

  const statusLabels: Record<ConnectionStatus, string> = {
    synced: 'Synced',
    connecting: 'Connecting',
    reconnecting: 'Reconnecting',
    offline: 'Offline',
    closed: 'Closed',
  };

  const label = statusLabels[currentStatus] || currentStatus;

  return (
    <span
      className={`connection-light-group ${currentStatus}`}
      role="status"
      data-testid={testId || 'connection-status'}
    >
      <span
        className={`connection-light ${currentStatus}`}
        data-status={currentStatus}
        aria-hidden="true"
      />
      <span className="connection-light-text">{label}</span>
    </span>
  );
}

export function ReconnectBanner({
  status,
  nextRetryAt,
  onRetry,
}: {
  status: 'reconnecting' | 'offline' | ConnectionStatus;
  nextRetryAt?: number | null;
  onRetry?: () => void;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (status !== 'reconnecting') return;
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [status]);

  if (status === 'offline') {
    return (
      <div className="reconnect-banner offline" role="status" aria-live="polite">
        <span>
          Connection lost. Your edits are safe. You're offline. Your edits stay on this device until
          you're back.
        </span>
        {onRetry && (
          <button type="button" className="btn ghost sm reconnect-retry-btn" onClick={onRetry}>
            Retry now
          </button>
        )}
      </div>
    );
  }

  if (status === 'reconnecting') {
    const remainingMs = Math.max(0, (nextRetryAt ?? Date.now() + 5000) - now);
    const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
    return (
      <div className="reconnect-banner" role="status" aria-live="polite">
        <span>Connection lost. Your edits are safe. Retrying in {seconds}s</span>
        {onRetry && (
          <button type="button" className="btn ghost sm reconnect-retry-btn" onClick={onRetry}>
            Retry now
          </button>
        )}
      </div>
    );
  }

  return null;
}
export function ThemeToggle({ paper, onChange }: { paper: boolean; onChange: () => void }) {
  return (
    <button
      className="theme-toggle"
      onClick={onChange}
      aria-label={paper ? 'Switch to dark theme' : 'Switch to paper theme'}
      title={paper ? 'Switch to dark theme' : 'Switch to paper theme'}
    >
      {paper ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
export function ResizeHandle() {
  return (
    <button className="resize-handle" aria-label="Resize panel">
      <Resize size={16} />
    </button>
  );
}
export function ListRow({ children }: { children: ReactNode }) {
  return <div className="list-row">{children}</div>;
}
export * from './ActivityFeed';
export * from './RoomSettingsModal';

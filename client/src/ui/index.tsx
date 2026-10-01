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
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'good' | 'bad';
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export type Status = 'Typing' | 'Active' | 'Idle' | 'Away' | 'Reconnecting';
export function StatusBadge({ status }: { status: Status }) {
  const reduced = useReducedMotion();
  return (
    <span className={`status status-${status.toLowerCase()}`} aria-label={`Status: ${status}`}>
      <i className={status === 'Typing' && !reduced ? 'wave' : ''} />
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
export function HostCrownTag() {
  return (
    <Badge tone="accent">
      <Crown size={12} /> HOST
    </Badge>
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
export function ConnectionLight({ reconnecting = false }: { reconnecting?: boolean }) {
  return (
    <span
      className={`connection-light ${reconnecting ? 'reconnecting' : ''}`}
      aria-label={reconnecting ? 'Reconnecting' : 'Connected'}
    />
  );
}
export function ThemeToggle({ paper, onChange }: { paper: boolean; onChange: () => void }) {
  return (
    <button className="theme-toggle" onClick={onChange} aria-label="Toggle theme">
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

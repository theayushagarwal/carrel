import { useEffect, useReducer, useRef } from 'react';
import type { PresenceState } from '@carrel/shared';
import type { CarrelProvider } from './CarrelProvider';

export function usePresence(provider: CarrelProvider | null, user: PresenceState['user'] | null) {
  const statusRef = useRef<PresenceState['status']>('active');
  const typingTimer = useRef<ReturnType<typeof setTimeout>>();
  const idleTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!provider || !user) return;
    const publish = (status: PresenceState['status']) => {
      if (statusRef.current === status) return;
      statusRef.current = status;
      provider.awareness.setLocalStateField('user', user);
      provider.awareness.setLocalStateField('status', status);
    };
    const setActive = () => {
      publish('active');
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => publish('idle'), 60000);
    };
    const onVisibility = () => publish(document.visibilityState === 'hidden' ? 'away' : 'active');
    const onFocus = () => setActive();
    provider.awareness.setLocalStateField('user', user);
    provider.awareness.setLocalStateField('status', 'active');
    setActive();
    window.addEventListener('pointermove', onFocus, { passive: true });
    window.addEventListener('keydown', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pointermove', onFocus);
      window.removeEventListener('keydown', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [provider, user]);
  return {
    noteTyping: () => {
      if (!provider || !user) return;
      if (typingTimer.current) clearTimeout(typingTimer.current);
      provider.awareness.setLocalStateField('user', user);
      provider.awareness.setLocalStateField('status', 'typing');
      typingTimer.current = setTimeout(() => {
        provider.awareness.setLocalStateField('user', user);
        provider.awareness.setLocalStateField('status', 'active');
      }, 1500);
    },
  };
}

export function useCoalescedAwareness(provider: CarrelProvider | null) {
  const mapRef = useRef<Record<number, PresenceState>>({});
  const frame = useRef<number>();
  const [, force] = useReducer((x) => (x + 1) | 0, 0);
  useEffect(() => {
    if (!provider) return;
    const flush = () => {
      frame.current = undefined;
      const next: Record<number, PresenceState> = {};
      provider.awareness.getStates().forEach((state, id) => {
        if (state?.user && state?.status) next[id] = state as PresenceState;
      });
      mapRef.current = next;
      force();
    };
    const onChange = () => {
      if (frame.current === undefined) frame.current = requestAnimationFrame(flush);
    };
    provider.awareness.on('change', onChange);
    flush();
    return () => {
      provider.awareness.off('change', onChange);
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
  }, [provider]);
  return mapRef.current;
}

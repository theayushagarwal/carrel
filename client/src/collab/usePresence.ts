import { useEffect, useRef, useState } from 'react';
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
      provider.awareness.setLocalState({ user, status });
    };
    const setActive = () => {
      publish('active');
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => publish('idle'), 60000);
    };
    const onVisibility = () => publish(document.visibilityState === 'hidden' ? 'away' : 'active');
    const onFocus = () => setActive();
    provider.awareness.setLocalState({ user, status: 'active' });
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
      provider.awareness.setLocalState({ user, status: 'typing' });
      typingTimer.current = setTimeout(
        () => provider.awareness.setLocalState({ user, status: 'active' }),
        1500,
      );
    },
  };
}

export function useCoalescedAwareness(provider: CarrelProvider | null) {
  const mapRef = useRef<Record<number, PresenceState>>({});
  const frame = useRef<number>();
  const [, force] = useStateTick();
  useEffect(() => {
    if (!provider) return;
    const flush = () => {
      frame.current = undefined;
      mapRef.current = {};
      provider.awareness.getStates().forEach((state, id) => {
        if (state?.user && state?.status) mapRef.current[id] = state as PresenceState;
      });
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
  }, [provider, force]);
  return mapRef.current;
}
function useStateTick() {
  const [, set] = useState(0);
  return [null, () => set((value) => value + 1)] as const;
}

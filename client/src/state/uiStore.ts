import { create } from 'zustand';
import type { PresenceState, RosterMember } from '@carrel/shared';

type UIState = {
  theme: 'dark' | 'paper';
  activeTab: 'editor' | 'people' | 'activity';
  feedOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  roster: RosterMember[];
  presence: Record<number, PresenceState>;
  set: (patch: Partial<UIState>) => void;
};
export const useUIStore = create<UIState>((set) => ({
  theme: 'dark',
  activeTab: 'editor',
  feedOpen: false,
  leftWidth: 260,
  rightWidth: 320,
  roster: [],
  presence: {},
  set: (patch) => set(patch),
}));

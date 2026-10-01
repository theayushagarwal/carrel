import { z } from 'zod';

export const ALLOWED_LANGUAGES = [
  'plaintext',
  'markdown',
  'javascript',
  'typescript',
  'python',
  'java',
  'cpp',
  'sql',
  'json',
] as const;
export type RoomLanguage = (typeof ALLOWED_LANGUAGES)[number];
export type PresenceStatus = 'typing' | 'active' | 'idle' | 'away';
export type PresenceState = {
  user: { id: string; name: string; color: string; colorLight: string };
  status: PresenceStatus;
  highlight?: { fromLine: number; toLine: number; pinned: boolean; ts: number };
};
export const controlMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('set_language'), language: z.enum(ALLOWED_LANGUAGES) }),
  z.object({ type: z.literal('set_readonly'), value: z.boolean() }),
  z.object({ type: z.literal('make_host'), clientId: z.string().min(1).max(120) }),
  z.object({ type: z.literal('kick'), clientId: z.string().min(1).max(120) }),
]);
export type ControlMessage = z.infer<typeof controlMessageSchema>;
export const roomUpdatedSchema = z.object({
  type: z.literal('room_updated'),
  language: z.enum(ALLOWED_LANGUAGES),
  readonly: z.boolean(),
});
export type RosterMember = {
  id: string;
  name: string;
  color: string;
  role: 'host' | 'member';
  joinedAt: number;
};

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
  z.object({ type: z.literal('ping'), t: z.number().optional() }),
  z.object({ type: z.literal('set_language'), language: z.enum(ALLOWED_LANGUAGES) }),
  z.object({ type: z.literal('set_readonly'), value: z.boolean() }),
  z.object({ type: z.literal('make_host'), clientId: z.string().min(1).max(120) }),
  z.object({ type: z.literal('kick'), clientId: z.string().min(1).max(120) }),
  z.object({ type: z.literal('set_passcode'), passcode: z.string().min(4).max(64) }),
  z.object({ type: z.literal('remove_passcode') }),
  z.object({
    type: z.literal('set_locked'),
    value: z.boolean().optional(),
    locked: z.boolean().optional(),
  }),
  z.object({ type: z.literal('audit_more'), beforeId: z.number().int().positive().optional() }),
]);
export type ControlMessage = z.infer<typeof controlMessageSchema>;
export const roomUpdatedSchema = z.object({
  type: z.literal('room_updated'),
  language: z.enum(ALLOWED_LANGUAGES),
  readonly: z.boolean(),
  locked: z.boolean().optional(),
  hasPasscode: z.boolean().optional(),
});
export const roleChangedSchema = z.object({
  type: z.literal('role_changed'),
  clientId: z.string(),
  role: z.enum(['host', 'member']),
  previousHostId: z.string().nullable().optional(),
  reason: z.string().optional(),
});
export const auditHistorySchema = z.object({
  type: z.literal('audit_history'),
  events: z.array(z.any()),
  hasMore: z.boolean(),
});
export type RosterMember = {
  id: string;
  name: string;
  color: string;
  role: 'host' | 'member';
  joinedAt: number;
  connected: boolean;
};

export type AuditEvent = {
  id: number;
  ts: number;
  event: string;
  actorId: string;
  actorName?: string;
  actorColor?: string;
  [key: string]: unknown;
};

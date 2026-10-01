import { z } from 'zod';

export const MESSAGE_TYPES = { sync: 0, awareness: 1, control: 2 } as const;
export const CLOSE_CODES = {
  badTicket: 4001,
  kicked: 4003,
  roomFull: 4008,
  roomLocked: 4009,
  policy: 1008,
} as const;
export const ROOM_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;
export const roomIdSchema = z
  .string()
  .regex(ROOM_SLUG, 'room id must be 3-32 lowercase letters, digits, or hyphens');
export const createRoomSchema = z.object({
  id: roomIdSchema.optional(),
  passcode: z.string().min(4).max(64).optional(),
  displayName: z.string().min(1).max(80),
  clientId: z.string().min(1).max(120),
});
export const joinRoomSchema = z.object({
  passcode: z.string().min(4).max(64).optional(),
  displayName: z.string().min(1).max(80),
  clientId: z.string().min(1).max(120),
  sessionToken: z.string().optional(),
  creatorKey: z.string().optional(),
});
export type CreateRoom = z.infer<typeof createRoomSchema>;
export type JoinRoom = z.infer<typeof joinRoomSchema>;

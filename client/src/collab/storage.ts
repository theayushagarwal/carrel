export type RecentRoom = { id: string; hasPasscode: boolean; lastVisited: number };
const key = (name: string) => `carrel:${name}`;
export function getClientId() {
  let value = localStorage.getItem(key('clientId'));
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem(key('clientId'), value);
  }
  return value;
}
export function getDisplayName() {
  return localStorage.getItem(key('displayName')) ?? '';
}
export const saveDisplayName = setDisplayName;
export function setDisplayName(name: string) {
  localStorage.setItem(key('displayName'), name);
}
export function saveRoomSession(
  roomId: string,
  data: { sessionToken: string; ticket?: string; creatorKey?: string; hasPasscode?: boolean },
) {
  localStorage.setItem(key(`session:${roomId}`), JSON.stringify(data));
  addRecentRoom(roomId, !!data.hasPasscode);
}
export function getRoomSession(
  roomId: string,
): { sessionToken: string; ticket?: string; creatorKey?: string; hasPasscode?: boolean } | null {
  try {
    return JSON.parse(localStorage.getItem(key(`session:${roomId}`)) ?? 'null');
  } catch {
    return null;
  }
}
export function addRecentRoom(id: string, hasPasscode: boolean) {
  const next = getRecentRooms().filter((room) => room.id !== id);
  next.unshift({ id, hasPasscode, lastVisited: Date.now() });
  localStorage.setItem(key('recentRooms'), JSON.stringify(next.slice(0, 8)));
}
export function getRecentRooms(): RecentRoom[] {
  try {
    return JSON.parse(localStorage.getItem(key('recentRooms')) ?? '[]');
  } catch {
    return [];
  }
}
export function paneSizes() {
  try {
    return JSON.parse(localStorage.getItem(key('paneSizes')) ?? '{}');
  } catch {
    return {};
  }
}
export function savePaneSizes(leftWidth: number, rightWidth: number) {
  localStorage.setItem(key('paneSizes'), JSON.stringify({ leftWidth, rightWidth }));
}
export function apiBase() {
  return (import.meta.env.VITE_API_URL as string) || '';
}
export function wsBase() {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL as string;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

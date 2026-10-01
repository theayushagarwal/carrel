import * as Y from 'yjs';
import { buildApp, loadConfig } from './index.js';
const server = buildApp(loadConfig());
const row = server.db.prepare('SELECT 1 FROM rooms WHERE id=?').get('dijkstra-notes');
if (!row) {
  const t = Date.now();
  server.db
    .prepare('INSERT INTO rooms(id,creator_key_hash,created_at,updated_at) VALUES(?,?,?,?)')
    .run('dijkstra-notes', Buffer.alloc(32), t, t);
  const doc = new Y.Doc();
  doc
    .getText('editor')
    .insert(
      0,
      `Dijkstra notes\n\nfunction dijkstra(graph, start) {\n  const distances = {};\n  const previous = {};\n  const queue = new Set(Object.keys(graph));\n  for (const node of queue) distances[node] = Infinity;\n  distances[start] = 0;\n  while (queue.size) {\n    const current = [...queue].reduce((a, b) => distances[a] < distances[b] ? a : b);\n    queue.delete(current);\n  }\n  return { distances, previous };\n}`,
    );
  server.db
    .prepare('INSERT INTO snapshots(room_id,ydoc_state,updated_at) VALUES(?,?,?)')
    .run('dijkstra-notes', Buffer.from(Y.encodeStateAsUpdate(doc)), t);
  console.log('seeded dijkstra-notes with a persisted Yjs note');
} else console.log('dijkstra-notes already exists');
await (server.app as any).closeCarrel();

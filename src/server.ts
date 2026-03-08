import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT          = Number(process.env.PORT) || 5050;
const DATA_DIR      = path.join(__dirname, '..', 'data');
const DATA_FILE     = path.join(DATA_DIR, 'channels.json');
const SAVE_DEBOUNCE = 500;
const NUM_CHANNELS  = 10;

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------
interface Channel {
  title:   string;
  content: string;
  version: number;
}

let channels: Channel[] = [];
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function defaultChannels(): Channel[] {
  return Array.from({ length: NUM_CHANNELS }, (_, i) => ({
    title:   `채널 ${i + 1}`,
    content: '',
    version: 0,
  }));
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------
function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadChannels(): Channel[] {
  try {
    const raw  = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw) as Channel[];
    if (Array.isArray(data) && data.length === NUM_CHANNELS) return data;
  } catch { /* file missing or corrupt → use defaults */ }
  return defaultChannels();
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(channels, null, 2), 'utf-8', (err) => {
      if (err) console.error('[persist] write error:', err);
      else     console.log('[persist] saved');
    });
  }, SAVE_DEBOUNCE);
}

function flushSync(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(channels, null, 2), 'utf-8');
    console.log('[persist] flushed on exit');
  } catch (err) {
    console.error('[persist] flush error:', err);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
ensureDataDir();
channels = loadChannels();
console.log(`[persist] loaded ${NUM_CHANNELS} channels`);

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer, { maxHttpBufferSize: 2 * 1024 * 1024 });

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', users: io.engine.clientsCount });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const roomName = (id: number) => `channel-${id}`;

interface UsersPayload {
  total:    number;
  channels: number[];   // per-channel user count, index = channelId
}

function broadcastUsers(): void {
  const channelCounts = Array.from({ length: NUM_CHANNELS }, (_, i) => {
    const room = io.sockets.adapter.rooms.get(roomName(i));
    return room ? room.size : 0;
  });
  const payload: UsersPayload = { total: io.engine.clientsCount, channels: channelCounts };
  io.emit('users', payload);
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------
io.on('connection', (socket: Socket) => {
  console.log(`[ws] connected: ${socket.id}`);

  // Send full channel list to the newly connected client
  socket.emit('listState', channels.map((ch, i) => ({ id: i, title: ch.title })));
  broadcastUsers();

  // ── Join a channel ──────────────────────────────────────────────────────
  socket.on('joinChannel', ({ channelId }: { channelId: number }) => {
    if (channelId < 0 || channelId >= NUM_CHANNELS) return;
    socket.join(roomName(channelId));
    const ch = channels[channelId];
    socket.emit('channelInit', {
      channelId,
      title:   ch.title,
      content: ch.content,
      version: ch.version,
    });
    broadcastUsers(); // update per-channel counts for everyone
  });

  // ── Leave a channel ─────────────────────────────────────────────────────
  socket.on('leaveChannel', ({ channelId }: { channelId: number }) => {
    if (channelId < 0 || channelId >= NUM_CHANNELS) return;
    socket.leave(roomName(channelId));
    broadcastUsers(); // update per-channel counts for everyone
  });

  // ── Content update ──────────────────────────────────────────────────────
  socket.on('updateContent', (payload: {
    channelId: number;
    content:   string;
    version:   number;
  }) => {
    const { channelId, content, version } = payload;
    if (channelId < 0 || channelId >= NUM_CHANNELS) return;
    if (typeof content !== 'string') return;

    const ch = channels[channelId];

    if (version < ch.version) {
      // Stale update – send authoritative state back to the sender
      socket.emit('channelInit', {
        channelId,
        title:   ch.title,
        content: ch.content,
        version: ch.version,
      });
      return;
    }

    ch.content  = content;
    ch.version += 1;

    socket.emit('contentAck', { channelId, version: ch.version });
    socket.to(roomName(channelId)).emit('contentUpdate', {
      channelId,
      content,
      version: ch.version,
    });

    scheduleSave();
  });

  // ── Title update (last-write-wins, no versioning needed) ────────────────
  socket.on('updateTitle', (payload: { channelId: number; title: string }) => {
    const { channelId, title } = payload;
    if (channelId < 0 || channelId >= NUM_CHANNELS) return;
    if (typeof title !== 'string') return;

    channels[channelId].title = title.slice(0, 100);

    // Notify all clients (both list viewers and channel users)
    io.emit('titleUpdate', { channelId, title: channels[channelId].title });
    scheduleSave();
  });

  // ── Disconnect ──────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[ws] disconnected: ${socket.id}`);
    broadcastUsers();
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
httpServer.listen(PORT, () => {
  console.log(`[server] listening on http://0.0.0.0:${PORT}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
const shutdown = (signal: string) => {
  console.log(`[server] received ${signal}, shutting down…`);
  flushSync();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 5050;
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'notepad.txt');
const SAVE_DEBOUNCE_MS = 500;   // wait 500 ms of silence before writing to disk

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let content = '';
let version = 0;          // monotonically increasing version counter
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// File persistence helpers
// ---------------------------------------------------------------------------
function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadContent(): string {
  try {
    return fs.readFileSync(DATA_FILE, 'utf-8');
  } catch {
    return '';
  }
}

function scheduleSave(text: string): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, text, 'utf-8', (err) => {
      if (err) console.error('[persist] write error:', err);
      else console.log(`[persist] saved (${Buffer.byteLength(text, 'utf-8')} bytes)`);
    });
  }, SAVE_DEBOUNCE_MS);
}

// Save immediately on process exit to avoid losing in-flight debounce
function flushSync(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    fs.writeFileSync(DATA_FILE, content, 'utf-8');
    console.log('[persist] flushed on exit');
  } catch (err) {
    console.error('[persist] flush error:', err);
  }
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------
ensureDataDir();
content = loadContent();
console.log(`[persist] loaded ${Buffer.byteLength(content, 'utf-8')} bytes from disk`);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  // Allow large payloads (default 1 MB is fine for a notepad)
  maxHttpBufferSize: 2 * 1024 * 1024, // 2 MB
});

// Serve static files from public/
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version, users: io.engine.clientsCount });
});

// ---------------------------------------------------------------------------
// Socket.IO event handling
// ---------------------------------------------------------------------------
io.on('connection', (socket: Socket) => {
  console.log(`[ws] connected: ${socket.id}`);

  // 1. Send current state to the new client
  socket.emit('init', { content, version });

  // 2. Notify everyone about the new user count
  io.emit('users', io.engine.clientsCount);

  // 3. Handle content updates from a client
  //    Payload: { content: string, version: number }
  socket.on('update', (payload: { content: string; version: number }) => {
    // Accept the update only if it is based on the current version or newer.
    // This prevents a stale client from overwriting a newer edit.
    if (typeof payload.content !== 'string') return;
    if (payload.version < version) {
      // Client is behind — send it the authoritative state instead
      socket.emit('init', { content, version });
      return;
    }

    content = payload.content;
    version += 1;

    // Acknowledge to the sender so it can update its local version counter
    socket.emit('ack', { version });

    // Broadcast to every OTHER connected client
    socket.broadcast.emit('update', { content, version });

    // Persist to disk (debounced)
    scheduleSave(content);
  });

  // 4. Clean up
  socket.on('disconnect', () => {
    console.log(`[ws] disconnected: ${socket.id}`);
    io.emit('users', io.engine.clientsCount);
  });
});

// ---------------------------------------------------------------------------
// Start listening
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

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

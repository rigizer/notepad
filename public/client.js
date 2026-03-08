/* ─────────────────────────────────────────────────────────────────────────
   Collaborative Notepad – client
   Protocol:
     C → S  update  { content: string, version: number }
     S → C  init    { content: string, version: number }   (on connect / conflict)
     S → C  update  { content: string, version: number }   (peer change)
     S → C  users   number
   ───────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const editor      = /** @type {HTMLTextAreaElement} */ (document.getElementById('editor'));
  const connBadge   = document.getElementById('conn-badge');
  const connText    = document.getElementById('conn-text');
  const userCount   = document.getElementById('user-count');
  const saveBadge   = document.getElementById('save-badge');
  const charCount   = document.getElementById('char-count');
  const lineCount   = document.getElementById('line-count');
  const versionLabel= document.getElementById('version-label');

  // ── State ─────────────────────────────────────────────────────────────────
  let localVersion  = 0;   // last known server version
  let sending       = false; // true while an update is in-flight (future use)
  let sendTimer     = null;  // debounce handle for outgoing updates
  const SEND_DEBOUNCE_MS = 80; // ms to wait after last keystroke before emitting

  // ── Socket.IO ─────────────────────────────────────────────────────────────
  const socket = io({ transports: ['websocket', 'polling'] });

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Apply content from the server, preserving the cursor position as best we can. */
  function applyRemoteContent(newContent) {
    if (newContent === editor.value) return; // no-op

    const sel   = { start: editor.selectionStart, end: editor.selectionEnd };
    const delta = newContent.length - editor.value.length;

    editor.value = newContent;

    // Attempt to keep cursor in a reasonable position
    const newStart = Math.max(0, Math.min(sel.start + delta, newContent.length));
    const newEnd   = Math.max(0, Math.min(sel.end   + delta, newContent.length));
    editor.setSelectionRange(newStart, newEnd);

    updateStatusBar();
  }

  function updateStatusBar() {
    const text  = editor.value;
    const chars = text.length;
    const lines = text === '' ? 1 : text.split('\n').length;
    charCount.textContent   = `${chars.toLocaleString()}자`;
    lineCount.textContent   = `${lines.toLocaleString()}줄`;
    versionLabel.textContent = `v${localVersion}`;
  }

  function showSaveBadge() {
    saveBadge.classList.remove('hidden');
    clearTimeout(saveBadge._hideTimer);
    saveBadge._hideTimer = setTimeout(() => saveBadge.classList.add('hidden'), 1500);
  }

  function setConnected(ok) {
    connBadge.className = 'badge ' + (ok ? 'connected' : 'disconnected');
    connText.textContent = ok ? '연결됨' : '연결 끊김';
    editor.disabled = !ok;
  }

  // ── Outgoing (local edits → server) ──────────────────────────────────────
  editor.addEventListener('input', () => {
    updateStatusBar();

    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      socket.emit('update', { content: editor.value, version: localVersion });
      showSaveBadge();
    }, SEND_DEBOUNCE_MS);
  });

  // ── Incoming (server → local) ─────────────────────────────────────────────
  socket.on('connect', () => setConnected(true));
  socket.on('disconnect', () => setConnected(false));

  /** Full state sync – sent on first connect or after a version conflict. */
  socket.on('init', ({ content, version }) => {
    localVersion = version;
    applyRemoteContent(content);
    updateStatusBar();
  });

  /** Incremental update from another client. */
  socket.on('update', ({ content, version }) => {
    localVersion = version;
    applyRemoteContent(content);
    updateStatusBar();
  });

  socket.on('users', (count) => {
    userCount.textContent = String(count);
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  setConnected(false);
  updateStatusBar();
})();

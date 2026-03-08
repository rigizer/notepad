/* ─────────────────────────────────────────────────────────────────────────
   Collaborative Notepad – client
   Protocol:
     C → S  update  { content: string, version: number }
     S → C  ack     { version: number }          ← new: confirms sender's version
     S → C  init    { content: string, version: number }   (connect / conflict)
     S → C  update  { content: string, version: number }   (peer change)
     S → C  users   number
   ───────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const editor       = /** @type {HTMLTextAreaElement} */ (document.getElementById('editor'));
  const connBadge    = document.getElementById('conn-badge');
  const connText     = document.getElementById('conn-text');
  const userCount    = document.getElementById('user-count');
  const saveBadge    = document.getElementById('save-badge');
  const charCount    = document.getElementById('char-count');
  const lineCount    = document.getElementById('line-count');
  const versionLabel = document.getElementById('version-label');

  // ── State ─────────────────────────────────────────────────────────────────
  let localVersion   = 0;     // last version acknowledged by server
  let sendTimer      = null;  // debounce handle for outgoing updates

  // isDirty: true when user has typed since the last server ack.
  // While dirty, remote content updates are queued rather than applied
  // immediately, preventing in-progress text from being overwritten.
  let isDirty        = false;

  // isComposing: true during IME composition (Korean, Chinese, Japanese…).
  // We must NOT send mid-composition because the in-flight partial character
  // would be echoed back and corrupt the cursor / glyph assembly.
  let isComposing    = false;

  // pendingRemote: the latest remote state received while dirty/composing.
  // Applied once the local edit is acknowledged.
  let pendingRemote  = null;  // { content, version } | null

  const SEND_DEBOUNCE_MS = 80;

  // ── Socket.IO ─────────────────────────────────────────────────────────────
  const socket = io({ transports: ['websocket', 'polling'] });

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Apply content received from the server.
   * Preserves cursor position using a prefix-match heuristic:
   *   - If the text before the cursor is unchanged, keep the cursor exactly.
   *   - Otherwise shift by the length delta (best-effort).
   */
  function applyRemoteContent(newContent) {
    if (newContent === editor.value) return;

    const start = editor.selectionStart;
    const end   = editor.selectionEnd;
    const old   = editor.value;

    editor.value = newContent;

    // Find how much of the prefix (before cursor) survived unchanged
    let commonPrefix = 0;
    const limit = Math.min(start, newContent.length);
    while (commonPrefix < limit && old[commonPrefix] === newContent[commonPrefix]) {
      commonPrefix++;
    }

    let newStart, newEnd;
    if (commonPrefix === start) {
      // Text before cursor is identical → keep cursor exactly
      newStart = Math.min(start, newContent.length);
      newEnd   = Math.min(end,   newContent.length);
    } else {
      // Shift by length delta as a fallback
      const delta = newContent.length - old.length;
      newStart = Math.max(0, Math.min(start + delta, newContent.length));
      newEnd   = Math.max(0, Math.min(end   + delta, newContent.length));
    }

    editor.setSelectionRange(newStart, newEnd);
    updateStatusBar();
  }

  function updateStatusBar() {
    const text  = editor.value;
    const chars = text.length;
    const lines = text === '' ? 1 : text.split('\n').length;
    charCount.textContent    = `${chars.toLocaleString()}자`;
    lineCount.textContent    = `${lines.toLocaleString()}줄`;
    versionLabel.textContent = `v${localVersion}`;
  }

  function showSaveBadge() {
    saveBadge.classList.remove('hidden');
    clearTimeout(saveBadge._hideTimer);
    saveBadge._hideTimer = setTimeout(() => saveBadge.classList.add('hidden'), 1500);
  }

  function setConnected(ok) {
    connBadge.className  = 'badge ' + (ok ? 'connected' : 'disconnected');
    connText.textContent = ok ? '연결됨' : '연결 끊김';
    editor.disabled      = !ok;
  }

  // ── Outgoing send (shared logic) ──────────────────────────────────────────
  function doSend() {
    if (isComposing) return;   // never send mid-IME
    socket.emit('update', { content: editor.value, version: localVersion });
    showSaveBadge();
  }

  // ── User input ────────────────────────────────────────────────────────────

  // compositionstart fires when IME begins assembling a character (e.g. 한글)
  editor.addEventListener('compositionstart', () => {
    isComposing = true;
  });

  // compositionend fires when the composed character is committed
  editor.addEventListener('compositionend', () => {
    isComposing = false;
    // Trigger a send now that composition is complete
    clearTimeout(sendTimer);
    sendTimer = setTimeout(doSend, SEND_DEBOUNCE_MS);
  });

  editor.addEventListener('input', () => {
    isDirty = true;
    updateStatusBar();

    if (isComposing) return;   // wait for compositionend

    clearTimeout(sendTimer);
    sendTimer = setTimeout(doSend, SEND_DEBOUNCE_MS);
  });

  // ── Incoming: server acknowledges our update ──────────────────────────────
  socket.on('ack', ({ version }) => {
    // Server accepted our update – safe to advance local version.
    localVersion = version;
    isDirty      = false;

    // Apply any remote change that arrived while we were dirty
    if (pendingRemote && !isComposing) {
      const { content, version: rv } = pendingRemote;
      pendingRemote = null;
      localVersion  = rv;
      applyRemoteContent(content);
    }
  });

  // ── Incoming: full state sync (first connect or version conflict) ──────────
  socket.on('init', ({ content, version }) => {
    localVersion = version;

    if (isDirty) {
      // Our in-flight edit conflicted. Don't overwrite what the user typed;
      // instead resend immediately with the refreshed version number so the
      // server will accept it.
      clearTimeout(sendTimer);
      doSend();
    } else {
      applyRemoteContent(content);
    }

    updateStatusBar();
  });

  // ── Incoming: peer change ─────────────────────────────────────────────────
  socket.on('update', ({ content, version }) => {
    if (isDirty || isComposing) {
      // Queue the remote state; apply it after our pending send is acked.
      // Keeping only the latest is fine for last-write-wins semantics.
      pendingRemote = { content, version };
    } else {
      localVersion = version;
      applyRemoteContent(content);
    }
    updateStatusBar();
  });

  // ── Connection lifecycle ──────────────────────────────────────────────────
  socket.on('connect',    () => setConnected(true));
  socket.on('disconnect', () => setConnected(false));

  socket.on('users', (count) => {
    userCount.textContent = String(count);
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  setConnected(false);
  updateStatusBar();
})();

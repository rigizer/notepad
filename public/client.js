/* ─────────────────────────────────────────────────────────────────────────
   Collaborative Notepad – client
   ─────────────────────────────────────────────────────────────────────────
   Server → Client events:
     listState    Array<{id, title}>          full list on connect
     titleUpdate  {channelId, title}          real-time title broadcast
     channelInit  {channelId, title, content, version}   join / conflict
     contentUpdate {channelId, content, version}         peer edit
     contentAck   {channelId, version}        confirms our edit
     users        {total, channels: number[]} connection counts
   Client → Server events:
     joinChannel  {channelId}
     leaveChannel {channelId}
     updateContent {channelId, content, version}
     updateTitle   {channelId, title}
   ───────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  const NUM_CHANNELS = 10;

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const listView     = document.getElementById('list-view');
  const channelView  = document.getElementById('channel-view');
  const channelGrid  = document.getElementById('channel-grid');

  // list-view header
  const listConnBadge = document.getElementById('list-conn-badge');
  const listConnText  = document.getElementById('list-conn-text');
  const listUserCount = document.getElementById('list-user-count');

  // channel-view header
  const backBtn      = document.getElementById('back-btn');
  const titleInput   = document.getElementById('title-input');
  const chUserBadge  = document.getElementById('ch-user-badge');
  const chUserCount  = document.getElementById('ch-user-count');
  const chConnBadge  = document.getElementById('ch-conn-badge');
  const chConnText   = document.getElementById('ch-conn-text');
  const saveBadge    = document.getElementById('save-badge');

  // channel-view editor
  const editor       = /** @type {HTMLTextAreaElement} */ (document.getElementById('editor'));
  const charCount    = document.getElementById('char-count');
  const lineCount    = document.getElementById('line-count');
  const versionLabel = document.getElementById('version-label');

  // ── App state ─────────────────────────────────────────────────────────────
  let view             = 'list';  // 'list' | 'channel'
  let currentChannelId = -1;

  // Channel list data (updated by server events)
  const channelData = Array.from({ length: NUM_CHANNELS }, (_, i) => ({
    title:     `채널 ${i + 1}`,
    userCount: 0,
  }));

  // ── Content-sync state (per channel session) ──────────────────────────────
  let localVersion  = 0;
  let isDirty       = false;    // typed since last ack
  let isComposing   = false;    // inside IME composition
  let pendingRemote = null;     // { content, version } queued while dirty
  let sendTimer     = null;
  let titleTimer    = null;

  const SEND_DEBOUNCE_MS  = 80;
  const TITLE_DEBOUNCE_MS = 300;

  // ── Socket.IO ─────────────────────────────────────────────────────────────
  const socket = io({ transports: ['websocket', 'polling'] });

  // ── Connection status helpers ─────────────────────────────────────────────
  function setConnected(ok) {
    const cls = ok ? 'badge connected' : 'badge disconnected';
    const txt = ok ? '연결됨' : '연결 끊김';

    listConnBadge.className = cls;
    listConnText.textContent = txt;

    chConnBadge.className = cls;
    chConnText.textContent = txt;

    editor.disabled = !ok;
    titleInput.disabled = !ok;
  }

  // ── List view ─────────────────────────────────────────────────────────────

  function renderChannelGrid() {
    channelGrid.innerHTML = '';
    for (let i = 0; i < NUM_CHANNELS; i++) {
      const { title, userCount } = channelData[i];
      const displayTitle = title.trim() || `채널 ${i + 1}`;
      const active = userCount > 0;

      const card = document.createElement('div');
      card.className  = 'ch-card';
      card.dataset.id = String(i);
      card.innerHTML  = `
        <div class="ch-card-num">CH ${String(i + 1).padStart(2, '0')}</div>
        <div class="ch-card-title">${escapeHtml(displayTitle)}</div>
        <div class="ch-card-users ${active ? 'active' : ''}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          ${userCount > 0 ? `${userCount}명 접속 중` : '비어 있음'}
        </div>`;
      card.addEventListener('click', () => enterChannel(i));
      channelGrid.appendChild(card);
    }
  }

  /** Update a single card without re-rendering all 10. */
  function updateCard(id) {
    const card = channelGrid.querySelector(`[data-id="${id}"]`);
    if (!card) return;

    const { title, userCount } = channelData[id];
    const displayTitle = title.trim() || `채널 ${id + 1}`;
    const active = userCount > 0;

    card.querySelector('.ch-card-title').textContent = displayTitle;

    const usersEl = card.querySelector('.ch-card-users');
    usersEl.className = `ch-card-users ${active ? 'active' : ''}`;
    usersEl.lastChild.textContent = userCount > 0 ? `${userCount}명 접속 중` : '비어 있음';
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  function showListView() {
    view = 'list';
    listView.classList.remove('hidden');
    channelView.classList.add('hidden');
  }

  function showChannelView() {
    listView.classList.add('hidden');
    channelView.classList.remove('hidden');
    view = 'channel';
  }

  function enterChannel(id) {
    // Reset state for new channel session
    currentChannelId = id;
    localVersion  = 0;
    isDirty       = false;
    isComposing   = false;
    pendingRemote = null;
    clearTimeout(sendTimer);
    clearTimeout(titleTimer);

    editor.value     = '';
    titleInput.value = '';
    updateStatusBar();
    showChannelView();

    socket.emit('joinChannel', { channelId: id });
  }

  function leaveChannel() {
    if (currentChannelId < 0) return;

    // Flush any pending content
    clearTimeout(sendTimer);
    if (isDirty) doSendContent();

    // Flush any pending title
    clearTimeout(titleTimer);

    socket.emit('leaveChannel', { channelId: currentChannelId });
    currentChannelId = -1;
    isDirty = false;
    pendingRemote = null;

    showListView();
  }

  backBtn.addEventListener('click', leaveChannel);

  // ── Status bar ────────────────────────────────────────────────────────────

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
    clearTimeout(saveBadge._t);
    saveBadge._t = setTimeout(() => saveBadge.classList.add('hidden'), 1500);
  }

  // ── Content send ──────────────────────────────────────────────────────────

  function doSendContent() {
    if (isComposing || currentChannelId < 0) return;
    socket.emit('updateContent', {
      channelId: currentChannelId,
      content:   editor.value,
      version:   localVersion,
    });
    showSaveBadge();
  }

  // ── Tab key → 4 spaces ───────────────────────────────────────────────────

  editor.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();

    const start  = editor.selectionStart;
    const end    = editor.selectionEnd;
    const indent = '    '; // 4 spaces

    // Replace selection with spaces (handles multi-char selection too)
    editor.value = editor.value.substring(0, start) + indent + editor.value.substring(end);
    editor.selectionStart = editor.selectionEnd = start + indent.length;

    // Trigger normal input flow
    editor.dispatchEvent(new Event('input'));
  });

  // ── IME composition ───────────────────────────────────────────────────────

  editor.addEventListener('compositionstart', () => {
    isComposing = true;
  });

  editor.addEventListener('compositionend', () => {
    isComposing = false;
    clearTimeout(sendTimer);
    sendTimer = setTimeout(doSendContent, SEND_DEBOUNCE_MS);
  });

  // ── Input (typing) ────────────────────────────────────────────────────────

  editor.addEventListener('input', () => {
    isDirty = true;
    updateStatusBar();
    if (isComposing) return;
    clearTimeout(sendTimer);
    sendTimer = setTimeout(doSendContent, SEND_DEBOUNCE_MS);
  });

  // ── Title editing ─────────────────────────────────────────────────────────

  titleInput.addEventListener('input', () => {
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      if (currentChannelId < 0) return;
      socket.emit('updateTitle', {
        channelId: currentChannelId,
        title:     titleInput.value,
      });
    }, TITLE_DEBOUNCE_MS);
  });

  // ── Incoming: server ack for content ─────────────────────────────────────

  socket.on('contentAck', ({ channelId, version }) => {
    if (channelId !== currentChannelId) return;
    localVersion = version;
    isDirty      = false;

    if (pendingRemote && !isComposing) {
      const { content, version: rv } = pendingRemote;
      pendingRemote = null;
      localVersion  = rv;
      applyRemoteContent(content);
    }
    updateStatusBar();
  });

  // ── Incoming: full channel state (join or conflict) ──────────────────────

  socket.on('channelInit', ({ channelId, title, content, version }) => {
    if (channelId !== currentChannelId) return;
    localVersion = version;
    titleInput.value = title;

    if (isDirty) {
      // Conflict – don't overwrite user's in-progress text; resend immediately
      clearTimeout(sendTimer);
      doSendContent();
    } else {
      applyRemoteContent(content);
    }
    updateStatusBar();
  });

  // ── Incoming: peer content update ────────────────────────────────────────

  socket.on('contentUpdate', ({ channelId, content, version }) => {
    if (channelId !== currentChannelId) return;
    if (isDirty || isComposing) {
      pendingRemote = { content, version };
    } else {
      localVersion = version;
      applyRemoteContent(content);
    }
    updateStatusBar();
  });

  // ── Incoming: title update (from any client) ──────────────────────────────

  socket.on('titleUpdate', ({ channelId, title }) => {
    channelData[channelId].title = title;

    if (view === 'list') {
      updateCard(channelId);
    } else if (channelId === currentChannelId) {
      // Don't overwrite if the user is actively editing the title field
      if (document.activeElement !== titleInput) {
        titleInput.value = title;
      }
    }
  });

  // ── Incoming: full list on connect ───────────────────────────────────────

  socket.on('listState', (list) => {
    list.forEach(({ id, title }) => {
      channelData[id].title = title;
    });
    renderChannelGrid();
  });

  // ── Incoming: user counts ─────────────────────────────────────────────────

  socket.on('users', ({ total, channels }) => {
    // Update total
    listUserCount.textContent = String(total);

    // Update per-channel counts
    channels.forEach((count, id) => {
      channelData[id].userCount = count;
      if (view === 'list') {
        updateCard(id);
      }
    });

    // Update channel-view badge
    if (view === 'channel' && currentChannelId >= 0) {
      const cnt = channels[currentChannelId] ?? 0;
      chUserCount.textContent = String(cnt);
      chUserBadge.className = cnt > 0 ? 'badge accent' : 'badge';
    }
  });

  // ── Connection lifecycle ──────────────────────────────────────────────────

  socket.on('connect',    () => setConnected(true));
  socket.on('disconnect', () => setConnected(false));

  // ── Content apply helper ──────────────────────────────────────────────────

  function applyRemoteContent(newContent) {
    if (newContent === editor.value) return;

    const start = editor.selectionStart;
    const end   = editor.selectionEnd;
    const old   = editor.value;

    editor.value = newContent;

    // Cursor: keep exactly if text before cursor is unchanged; else use delta
    let commonPrefix = 0;
    const limit = Math.min(start, newContent.length);
    while (commonPrefix < limit && old[commonPrefix] === newContent[commonPrefix]) {
      commonPrefix++;
    }

    let newStart, newEnd;
    if (commonPrefix === start) {
      newStart = Math.min(start, newContent.length);
      newEnd   = Math.min(end,   newContent.length);
    } else {
      const delta = newContent.length - old.length;
      newStart = Math.max(0, Math.min(start + delta, newContent.length));
      newEnd   = Math.max(0, Math.min(end   + delta, newContent.length));
    }

    editor.setSelectionRange(newStart, newEnd);
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  setConnected(false);
  renderChannelGrid();
  updateStatusBar();
})();

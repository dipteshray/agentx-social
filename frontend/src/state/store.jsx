// AgentX Social — central store for the React frontend.
// A faithful port of the vanilla SPA state machine (public/app.js v0.12.2):
// one state object, the same views, the same generation guard on
// room-scoped fetches, the same sync+ack polling, the same toasts.
// Components read state via useAgentX() and call the actions it returns.
// Actions are plain function declarations (hoisted) so they may call each
// other in any order; they read the latest state through stateRef.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, getToken, setToken, clearToken, isOwnerSession, setOwnerSession,
  isReadOnlyErr, READONLY_MSG, num, uid, parseDeepLink, truncateWords,
} from '../api/client.js';
import { uploadAndPostFile } from '../api/files.js';

const AgentXContext = createContext(null);
export function useAgentX() {
  const ctx = useContext(AgentXContext);
  if (!ctx) throw new Error('useAgentX must be used inside <AgentXProvider>');
  return ctx;
}

function initialState() {
  return {
    token: getToken(),
    owner: isOwnerSession(),
    me: null,
    view: 'auth',
    booted: false,
    offline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
    rooms: [],
    currentRoom: null,
    roomDetails: null,
    roomMembersCache: [],
    // v0.14.1: the cache alone cannot tell "loading" from "empty" — openRoom
    // resets it to [] on every switch, so the RightBar (and any consumer
    // reading the cache) flashed "No members listed." while the detail
    // fetch was still in flight. This flag is the loading gate (same rule
    // as the v0.14.0 members modal: null/spinner while loading, the empty
    // state only after a completed load really returns zero members).
    roomMembersLoading: false,
    myRole: null,
    messages: [],
    messagesLoading: false,
    unread: {},
    unreadMentions: 0,
    lastMsg: {},
    syncCursor: 0,
    quote: null,
    editingId: null,
    feedPosts: [],
    feedBefore: {},
    feedLoading: false,
    roomFilter: null,
    saved: [],
    savedLoading: true,
    mentions: [],
    mentionsLoading: true,
    searchResults: null,
    searchCursor: null,
    searchHasMore: false,
    searchQuery: '',
    pendingDeepLink: null,
    users: [],
    usersCursor: null,
    usersLoading: true,
    usersQuery: '',
    loadOlderExhausted: false,
    toasts: [],
    modal: null, // {type, ...props}
    highlightId: null,
    mobileChatOpen: false,
    ownerOverview: null,
    ownerQuota: null,
    ownerApprovals: null,
    ownerRules: null,
    ownerInvites: null,
    ownerBulkInvites: [],
    ownerRooms: [],
    ownerRoomsLoading: true,
    ownerThreadRoom: null,
    ownerThreadMsgs: [],
    ownerThreadMembers: [],
    ownerThreadLoading: false,
    ownerSearchResults: null,
    ownerDashboardReady: false,
    previewOpen: false,
    previewRooms: [],
    previewCurrentRoom: null,
    previewPosts: [],
    previewBefore: {},
    previewRoomFilter: null,
    previewMembers: {},
    previewRoomMembers: [],
    previewRoomExhausted: false,
    previewLoading: false,
    previewSrijonId: null,
    previewPane: 'feed',
    nowTick: Date.now(),
  };
}

export function AgentXProvider({ children }) {
  const [state, setState] = useState(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const roomGenRef = useRef(0);
  const previewGenRef = useRef(0);
  const authorCacheRef = useRef({});
  const pollTimerRef = useRef(null);
  const bootedRef = useRef(false);

  const patch = useCallback((p) => {
    setState((prev) => ({ ...prev, ...(typeof p === 'function' ? p(stateRef.current) : p) }));
  }, []);

  // ---- toasts -------------------------------------------------------------
  const toast = useCallback((msg, kind = '') => {
    const id = uid();
    patch((s) => ({ toasts: [...s.toasts, { id, msg, kind }] }));
    setTimeout(() => patch((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 6000);
  }, [patch]);

  const apiErrorToast = useCallback((err, fallback = 'Something went wrong') => {
    if (err?.status === 429) return;
    if (isReadOnlyErr(err)) { toast(READONLY_MSG, 'error'); return; }
    toast(err?.status === 403 ? (err.message || 'Forbidden') : (err.message || fallback), 'error');
  }, [toast]);

  // ---- session ------------------------------------------------------------
  function logout(msg) {
    clearToken();
    setOwnerSession(false);
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    patch({ token: '', owner: false, me: null, currentRoom: null, view: 'auth', rooms: [], messages: [], feedPosts: [], previewOpen: false });
    document.body.classList.remove('mobile-chat-open');
    if (msg) toast(msg);
  }

  // api() wrapper that logs out on 401 (vanilla behaviour), except while
  // already on the auth view. Owner-only raw probes bypass this wrapper.
  function apiCall(path, opts = {}) {
    return api(path, {
      ...opts,
      onUnauthorized: () => {
        if (stateRef.current.view !== 'auth') logout('Your session expired — please log in again.');
      },
    });
  }
  function ownerApi(path, opts = {}) {
    return apiCall(path, { ...opts, token: '', credentials: 'include' });
  }

  // ---- authors ------------------------------------------------------------
  function authorName(m) {
    if (m.sender?.display_name || m.sender?.handle) return m.sender.display_name || m.sender.handle;
    if (m.sender_display_name || m.sender_handle) return m.sender_display_name || m.sender_handle;
    const a = m.author || m.agent || authorCacheRef.current[m.sender_id] || authorCacheRef.current[m.agent_id] || {};
    return a.display_name || a.handle || m.author_handle || (m.sender_id ? 'agent ' + String(m.sender_id).slice(-6) : 'agent');
  }
  function authorHandle(m) {
    if (m.sender?.handle) return m.sender.handle;
    const a = m.author || m.agent || authorCacheRef.current[m.sender_id] || authorCacheRef.current[m.agent_id] || {};
    return a.handle || m.sender_handle || '';
  }
  function authorId(m) { return m.sender?.id || m.sender_id || m.agent_id || null; }
  async function resolveAuthors(msgs) {
    const missing = [...new Set(msgs.map((m) => m.sender_id || m.agent_id).filter((id) => {
      if (!id || authorCacheRef.current[id]) return false;
      return !msgs.find((x) => (x.sender_id || x.agent_id) === id)?.sender;
    }))];
    if (!missing.length) return false;
    let changed = false;
    await Promise.all(missing.map(async (id) => {
      try {
        const data = await apiCall(`/api/v1/agents/${encodeURIComponent(id)}`);
        authorCacheRef.current[id] = data.agent || data; changed = true;
      } catch { authorCacheRef.current[id] = {}; }
    }));
    return changed;
  }

  // ---- view / navigation --------------------------------------------------
  function showView(name) {
    patch({ view: name });
    const bootEl = document.getElementById('boot-loading');
    if (bootEl) bootEl.classList.add('hidden');
  }

  useEffect(() => {
    const open = ['chat', 'search', 'feed', 'profile', 'saved', 'mentions', 'users'].includes(state.view);
    document.body.classList.toggle('mobile-chat-open', open);
    if (stateRef.current.mobileChatOpen !== open) patch({ mobileChatOpen: open });
  }, [state.view]);

  function showChatList() {
    document.body.classList.remove('mobile-chat-open');
    patch({ mobileChatOpen: false });
  }

  // Mobile tab-bar active tab: view map, with the room filter winning on
  // the chat-list surface and inside an open chat (v0.12.2 rule).
  const activeTab = useMemo(() => {
    const map = { feed: 'home', search: 'search', mentions: 'mentions', profile: 'profile' };
    const onList = !state.mobileChatOpen;
    const f = state.roomFilter;
    if (onList && f) return f === 'group' ? 'groups' : f === 'channel' ? 'channels' : 'dms';
    if (state.view === 'chat') {
      return f === 'group' ? 'groups' : f === 'channel' ? 'channels' : f === 'dm' ? 'dms' : null;
    }
    return map[state.view] || null;
  }, [state.view, state.roomFilter, state.mobileChatOpen]);

  function setRoomFilter(type) {
    patch((s) => ({ roomFilter: s.roomFilter === type ? null : type }));
  }
  function clearRoomFilter() { patch({ roomFilter: null }); }

  async function copyMessageLink(m) {
    // Fallback uses THIS deployment's own origin, never a hardcoded URL.
    const url = m.permalink || `${window.location.origin}/m/${m.id}`;
    try { await navigator.clipboard.writeText(url); toast('Message link copied.'); }
    catch { toast(url); }
  }

  // ---- rooms --------------------------------------------------------------
  async function refreshRooms() {
    try {
      const data = await apiCall('/api/v1/rooms?limit=200');
      const rooms = data.rooms || data || [];
      patch((s) => {
        const lastMsg = { ...s.lastMsg };
        for (const r of rooms) {
          if (r.last_message) {
            const lm = r.last_message;
            lastMsg[r.id] = { ...lm, sender_display_name: lm.sender_handle, sender_handle: lm.sender_handle };
          } else {
            delete lastMsg[r.id];
          }
        }
        return { rooms, lastMsg };
      });
      return rooms;
    } catch (err) { apiErrorToast(err, 'Could not load rooms'); return []; }
  }

  async function refreshInbox() {
    try {
      const data = await apiCall('/api/v1/inbox/summary');
      const unread = {};
      for (const r of data.rooms || []) unread[r.room_id] = num(r.unread);
      patch({ unread, unreadMentions: num(data.unread_mentions) });
    } catch { /* inbox is best-effort */ }
  }

  async function loadMessages(before) {
    const room = stateRef.current.currentRoom;
    if (!room) return null;
    try {
      const q = before ? `?before=${encodeURIComponent(before)}` : '';
      const data = await apiCall(`/api/v1/rooms/${encodeURIComponent(room.handle || room.id)}/messages${q}`);
      // Generation guard (same class as the v0.12.2 room-detail race): a
      // slow load from a room the user already left must never overwrite
      // the new room's messages — and must not clear the new room's
      // loading flag either (the finally below checks the same condition).
      if (stateRef.current.currentRoom?.id !== room.id) return null;
      const msgs = data.messages || data || [];
      patch((s) => {
        const next = before ? [...msgs, ...s.messages] : msgs;
        const lastMsg = { ...s.lastMsg };
        if (msgs.length) lastMsg[room.id] = msgs[msgs.length - 1];
        return { messages: next, lastMsg };
      });
      resolveAuthors(msgs).then((changed) => { if (changed) patch((s) => ({ messages: [...s.messages] })); });
      return msgs.length;
    } catch (err) { apiErrorToast(err, 'Could not load messages'); return null; }
    finally {
      // Loading is over for this room only — the empty state may render
      // now, and never before (a loading list must never flash as empty).
      if (stateRef.current.currentRoom?.id === room.id) patch({ messagesLoading: false });
    }
  }

  async function loadOlder() {
    const s = stateRef.current;
    if (!s.messages.length) return;
    const n = await loadMessages(s.messages[0].id);
    if (n === 0) patch({ loadOlderExhausted: true });
  }

  async function openRoom(room) {
    showView('chat');
    const gen = (roomGenRef.current = (roomGenRef.current || 0) + 1);
    patch({
      currentRoom: room, messages: [], messagesLoading: true, quote: null, editingId: null,
      roomMembersCache: [], roomMembersLoading: true, roomDetails: null, myRole: null, loadOlderExhausted: false,
    });
    try {
      const data = await apiCall(`/api/v1/rooms/${encodeURIComponent(room.handle || room.id)}`);
      if (gen !== roomGenRef.current) return;
      const details = data.room || data;
      if (details.resolved_via_alias) toast(`Room renamed — now @${details.handle} (was @${details.resolved_via_alias}).`);
      const members = data.members || details.members || [];
      const me = members.find((mm) => ((mm.agent || mm).id === stateRef.current.me?.id));
      patch((s) => {
        const rooms = s.rooms.map((r) => (r.id === details.id && details.can_post !== undefined ? { ...r, can_post: details.can_post } : r));
        return { roomDetails: details, roomMembersCache: members, myRole: (me?.agent || me)?.role || null, rooms };
      });
    } catch (err) { if (gen === roomGenRef.current) apiErrorToast(err, 'Could not load room details'); }
    // v0.14.1: clear the members-loading gate on EVERY settle path (success
    // above, failure here) — never leave the RightBar on its spinner, and
    // never clear it for a superseded generation (the newer openRoom owns
    // the flag then). Cleared here, not after loadMessages: the members
    // arrive with the detail fetch, not with the messages.
    if (gen === roomGenRef.current) patch({ roomMembersLoading: false });
    if (!room.joined && gen === roomGenRef.current) {
      try {
        await apiCall(`/api/v1/rooms/${encodeURIComponent(room.handle || room.id)}/join`, { method: 'POST' });
        patch((s) => ({ rooms: s.rooms.map((r) => (r.id === room.id ? { ...r, joined: true } : r)) }));
      } catch (err) { toast(err.message || 'Could not join room', 'error'); }
    }
    if (gen === roomGenRef.current) await loadMessages();
    refreshInbox();
  }

  async function leaveRoom(room) {
    try {
      await apiCall(`/api/v1/rooms/${encodeURIComponent(room.handle || room.id)}/leave`, { method: 'POST' });
      toast('Left the room.');
      await refreshRooms();
      const next = stateRef.current.rooms.find((r) => r.joined) || stateRef.current.rooms[0];
      if (next) await openRoom(next);
    } catch (err) {
      if (err.status === 403) toast('You cannot leave this room', 'error');
      else apiErrorToast(err, 'Could not leave room');
    }
  }

  async function createRoom({ type, name, handle, description, rules, visibility }) {
    const data = await apiCall('/api/v1/rooms', { method: 'POST', body: { type, name, handle, description, rules, visibility } });
    await refreshRooms();
    const created = stateRef.current.rooms.find((r) => r.id === data.room_id) || { handle: data.handle, id: data.room_id, type };
    await openRoom(created);
  }

  async function openDmWith(handle) {
    patch({ modal: null });
    try {
      const data = await apiCall('/api/v1/rooms', { method: 'POST', body: { type: 'dm', other_handle: handle } });
      if (data.existing) toast('That DM already existed — opened it.');
      await refreshRooms();
      await openRoom(stateRef.current.rooms.find((r) => r.id === data.room_id) || { handle: data.handle, id: data.room_id, type: 'dm' });
    } catch (err) { apiErrorToast(err, 'Could not open DM'); }
  }

  async function changeMemberRole(room, agent, role) {
    try {
      await apiCall(`/api/v1/rooms/${encodeURIComponent(room.handle || room.id)}/members/${encodeURIComponent(agent.handle)}/role`, { method: 'POST', body: { role } });
      toast(`${agent.handle} is now ${role === 'moderator' ? 'a moderator' : 'a member'}.`);
      await openRoom(stateRef.current.currentRoom);
    } catch (err) { apiErrorToast(err, 'Could not change role'); }
  }

  async function createRoomInvite(room) {
    const inv = await apiCall(`/api/v1/rooms/${encodeURIComponent(room.handle || room.id)}/invites`, { method: 'POST' });
    return inv.invite_hash || inv.hash || JSON.stringify(inv);
  }

  // ---- feed ---------------------------------------------------------------
  // roomsOverride: the caller passes the rooms it just fetched, because
  // React state updates from refreshRooms may not have flushed yet when
  // this runs (an awaited patch is not a flushed render).
  async function loadHomeFeed(more = false, roomsOverride) {
    const s = stateRef.current;
    const rooms = roomsOverride || s.rooms || [];
    if (!more) { patch({ feedPosts: [], feedBefore: {}, feedLoading: true }); }
    try {
      const lists = await Promise.all(rooms.map(async (r) => {
        const before = more ? (s.feedBefore[r.id] || '') : '';
        const q = before ? `?before=${encodeURIComponent(before)}` : '';
        const data = await apiCall(`/api/v1/rooms/${encodeURIComponent(r.handle || r.id)}/messages${q}`);
        const msgs = data.messages || [];
        if (msgs.length) s.feedBefore[r.id] = msgs[msgs.length - 1].id;
        return msgs.map((m) => ({ ...m, _room: r }));
      }));
      const all = lists.flat();
      all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      patch((cur) => ({
        feedPosts: (more ? [...cur.feedPosts, ...all] : all).slice(0, 100),
        feedBefore: { ...s.feedBefore },
        feedLoading: false,
      }));
      resolveAuthors(all).then((changed) => { if (changed) patch((cur) => ({ feedPosts: [...cur.feedPosts] })); });
    } catch (err) {
      patch({ feedLoading: false });
      apiErrorToast(err, 'Could not load feed');
    }
  }

  async function postToFeed(body) {
    const data = await apiCall('/api/v1/rooms/main-community/messages', { method: 'POST', body: { body, idempotency_key: uid() } });
    // Server answers {ok, message_id, room_sequence} — reload the feed
    // so the post appears at once (vanilla did the same).
    await loadHomeFeed(false);
    return data;
  }

  // ---- message actions ----------------------------------------------------
  async function sendMessage({ room, body, type = 'text', replyTo, trade, poll, fileId, caption, idempotencyKey }) {
    if (!room) return null;
    const payload = { body, type };
    if (replyTo) payload.reply_to = replyTo;
    if (trade) payload.trade = trade;
    if (poll) payload.poll = poll;
    if (fileId) payload.file_id = fileId;
    if (caption) payload.caption = caption;
    payload.idempotency_key = idempotencyKey || uid();
    const data = await apiCall(`/api/v1/rooms/${encodeURIComponent(room.handle || room.id)}/messages`, { method: 'POST', body: payload });
    // The server answers {ok, message_id, room_sequence} — no message
    // body — so reload the thread like the vanilla SPA did (the message
    // appears immediately instead of waiting for the next 5s poll).
    if (data.message) {
      const msg = data.message;
      patch((s) => {
        const lastMsg = { ...s.lastMsg, [room.id]: msg };
        return {
          messages: s.currentRoom?.id === room.id ? [...s.messages, msg] : s.messages,
          lastMsg,
          rooms: s.rooms.map((r) => (r.id === room.id ? { ...r, last_message: msg } : r)),
        };
      });
    }
    if (stateRef.current.currentRoom?.id === room.id) await loadMessages();
    else await refreshRooms();
    return data;
  }

  async function editMessage(id, body) {
    const s = stateRef.current;
    if (!s.currentRoom) return;
    await apiCall(`/api/v1/rooms/${encodeURIComponent(s.currentRoom.handle || s.currentRoom.id)}/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body: { body } });
    toast('Edited.');
    await loadMessages();
  }

  async function deleteMessage(id) {
    await apiCall(`/api/v1/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('Deleted.');
    await loadMessages();
  }

  async function reactToMessage(m, emoji) {
    await apiCall(`/api/v1/messages/${encodeURIComponent(m.id)}/reactions`, { method: 'POST', body: { emoji } });
    const fresh = await loadMessage(m.id);
    if (!fresh) return;
    patch((cur) => ({
      messages: cur.messages.map((x) => (x.id === m.id ? fresh : x)),
      feedPosts: cur.feedPosts.map((x) => (x.id === m.id ? { ...fresh, _room: x._room } : x)),
    }));
  }

  // The server returns raw rows [{emoji, agent_id, created_at}]; aggregate
  // into chips [{emoji, count, mine}] like the vanilla SPA did.
  async function loadReactions(m) {
    try {
      const data = await apiCall(`/api/v1/messages/${encodeURIComponent(m.id)}/reactions`);
      const rows = data.reactions || [];
      const byEmoji = {};
      for (const r of rows) {
        const e = byEmoji[r.emoji] || (byEmoji[r.emoji] = { emoji: r.emoji, count: 0, mine: false });
        e.count++;
        if (r.agent_id === stateRef.current.me?.id) e.mine = true;
      }
      return Object.values(byEmoji);
    } catch { return []; }
  }

  async function pinMessage(m, pinned) {
    const s = stateRef.current;
    const target = m._room || s.currentRoom;
    if (!target) return;
    const path = `/api/v1/rooms/${encodeURIComponent(target.handle || target.id)}/pins/${encodeURIComponent(m.id)}`;
    if (pinned) await apiCall(path, { method: 'POST' });
    else await apiCall(path, { method: 'DELETE' });
    toast(pinned ? 'Pinned.' : 'Unpinned.');
  }

  async function loadPins(room) {
    try {
      const data = await apiCall(`/api/v1/rooms/${encodeURIComponent(room.handle || room.id)}/pins`);
      return data.pins || [];
    } catch (err) { apiErrorToast(err, 'Could not load pins'); return []; }
  }

  async function saveMessage(m) {
    try { await apiCall(`/api/v1/messages/${encodeURIComponent(m.id)}/save`, { method: 'POST' }); toast('Saved.'); }
    catch (err) { apiErrorToast(err, 'Could not save message'); }
  }
  async function unsaveMessage(m) {
    try { await apiCall(`/api/v1/messages/${encodeURIComponent(m.id)}/unsave`, { method: 'POST' }); toast('Removed from Saved.'); }
    catch (err) { apiErrorToast(err, 'Could not remove'); }
  }

  async function forwardMessage(m, target) {
    const s = stateRef.current;
    const source = m._room || s.currentRoom;
    if (!source) return null;
    const toRoom = target.saved ? 'saved' : (target.room_id || target.handle || target.room_handle);
    const data = await apiCall(`/api/v1/rooms/${encodeURIComponent(source.handle || source.id)}/messages/${encodeURIComponent(m.id)}/forward`, { method: 'POST', body: { to_room: toRoom } });
    toast('Forwarded.');
    await refreshRooms();
    if (data.room_id) {
      const room = stateRef.current.rooms.find((r) => r.id === data.room_id);
      if (room) await openRoom(room);
    }
    return data;
  }

  async function votePoll(m, optionId) {
    const pollId = m.poll?.id;
    if (!pollId) throw new Error('This message has no poll id.');
    const data = await apiCall(`/api/v1/polls/${encodeURIComponent(pollId)}/vote`, { method: 'POST', body: { option_id: optionId } });
    patch((cur) => ({
      messages: cur.messages.map((x) => (x.id === m.id && data.poll ? { ...x, poll: data.poll } : x)),
      feedPosts: cur.feedPosts.map((x) => (x.id === m.id && data.poll ? { ...x, poll: data.poll } : x)),
    }));
  }

  async function loadMessage(mId) {
    const data = await apiCall(`/api/v1/messages/${encodeURIComponent(mId)}`);
    return data.message || data;
  }

  async function markSeen(room, messageId) {
    if (!room || !messageId) return;
    try { await apiCall(`/api/v1/rooms/${encodeURIComponent(room.handle || room.id)}/seen`, { method: 'POST', body: { message_id: messageId } }); }
    catch { /* best-effort */ }
  }

  async function loadSeenBy(m) {
    const s = stateRef.current;
    const target = m._room || s.currentRoom;
    if (!target) return [];
    try {
      const data = await apiCall(`/api/v1/rooms/${encodeURIComponent(target.handle || target.id)}/messages/${encodeURIComponent(m.id)}/seen`);
      return data.seen_by || data.seen || [];
    } catch { return []; }
  }

  // Deep-link / jump: scroll to a message, paging back first if needed.
  async function jumpToMessage(roomIdOrHandle, messageId) {
    let room = stateRef.current.rooms.find((r) => r.id === roomIdOrHandle || r.handle === roomIdOrHandle);
    if (!room) return;
    if (stateRef.current.currentRoom?.id !== room.id) await openRoom(room);
    const tryHighlight = () => {
      const el = document.querySelector(`[data-id="${messageId}"]`);
      if (!el) return false;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      patch({ highlightId: messageId });
      setTimeout(() => el.classList.remove('flash'), 2000);
      return true;
    };
    let tries = 0;
    const attempt = async () => {
      tries++;
      if (tryHighlight()) return;
      if (tries >= 5) {
        const msg = await loadMessage(messageId, room).catch(() => null);
        if (msg) { patch({ messages: [msg] }); setTimeout(tryHighlight, 50); }
        return;
      }
      await loadOlder();
      setTimeout(attempt, 120);
    };
    setTimeout(attempt, 80);
  }

  // ---- search / mentions / saved ------------------------------------------
  async function runSearch(params, more = false) {
    const s = stateRef.current;
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    if (more && s.searchCursor) q.set('cursor', s.searchCursor);
    const data = await apiCall(`/api/v1/search?${q.toString()}`);
    // v0.13.2: the search endpoint used to return only FTS rows (doc_id,
    // snippet, no id/body/sender) — the card rendered an empty body and
    // "agent", and open/copy used a missing id. The backend now returns
    // id/body/sender_handle/sender_display_name (v0.13.2); map defensively
    // so an older shape still renders: doc_id -> id, snippet (tags
    // stripped) -> body.
    const results = (data.results || []).map((r) => ({
      ...r,
      id: r.id || r.doc_id,
      body: r.body || String(r.snippet || '').replace(/<\/?b>/g, ''),
    }));
    patch((cur) => ({
      searchResults: more ? [...(cur.searchResults || []), ...results] : results,
      searchCursor: data.cursor || data.next_cursor || null,
      searchHasMore: Boolean(data.cursor || data.next_cursor),
      searchQuery: params.q || '',
    }));
    return results;
  }

  async function loadMentions() {
    patch({ mentionsLoading: true });
    try {
      const data = await apiCall('/api/v1/mentions?unread=true');
      patch({ mentions: data.mentions || [], unreadMentions: num(data.unread_mentions), mentionsLoading: false });
    } catch { patch({ mentionsLoading: false }); /* best-effort */ }
  }

  async function loadSaved() {
    patch({ savedLoading: true });
    try {
      const data = await apiCall('/api/v1/saved');
      patch({ saved: data.saved || [], savedLoading: false });
    } catch (err) { patch({ savedLoading: false }); apiErrorToast(err, 'Could not load saved messages'); }
  }

  // ---- users / follow -----------------------------------------------------
  async function loadUsers(query = '', more = false) {
    const s = stateRef.current;
    if (more && !s.usersCursor) return;
    patch({ usersLoading: true, usersQuery: query });
    try {
      const q = new URLSearchParams({ limit: '50' });
      if (query) q.set('q', query);
      if (more && s.usersCursor) q.set('cursor', s.usersCursor);
      const data = await apiCall(`/api/v1/agents?${q.toString()}`);
      patch((cur) => ({
        users: more ? [...cur.users, ...(data.agents || [])] : (data.agents || []),
        // The API returns next_cursor (like search); the client used to
        // read only data.cursor, so "Load more" could never appear past
        // the first page — found by the v0.13.1 harness (E4).
        usersCursor: data.cursor || data.next_cursor || null,
        usersLoading: false,
      }));
    } catch (err) { patch({ usersLoading: false }); apiErrorToast(err, 'Could not load users'); }
  }

  async function loadProfile(handle) {
    const data = await apiCall(`/api/v1/agents/${encodeURIComponent(handle)}`);
    const agent = data.agent || data;
    return { ...agent, followers: data.followers, following: data.following, followed_by_me: data.followed_by_me };
  }

  async function followAgent(handle) {
    const data = await apiCall(`/api/v1/agents/${encodeURIComponent(handle)}/follow`, { method: 'POST' });
    return data;
  }
  async function unfollowAgent(handle) {
    const data = await apiCall(`/api/v1/agents/${encodeURIComponent(handle)}/follow`, { method: 'DELETE' });
    return data;
  }
  async function loadFollowers(handle) {
    const data = await apiCall(`/api/v1/agents/${encodeURIComponent(handle)}/followers?limit=50`);
    return data.followers || data.agents || [];
  }
  async function loadFollowing(handle) {
    const data = await apiCall(`/api/v1/agents/${encodeURIComponent(handle)}/following?limit=50`);
    return data.following || data.agents || [];
  }

  async function updateProfile(fields) {
    const data = await apiCall('/api/v1/agents/me', { method: 'PATCH', body: fields });
    // PATCH /me returns {agent} only — no follower counts. Keep the
    // counts the session already has (from /me at login, or a profile
    // load), so the Profile view never falls back to 0s after an edit.
    const prev = stateRef.current.me || {};
    const next = data.agent || data;
    patch({ me: { ...next, followers: next.followers ?? prev.followers, following: next.following ?? prev.following } });
    toast('Profile updated.');
    return data;
  }

  // ---- auth ---------------------------------------------------------------
  async function enterChat() {
    showView('feed');
    const rooms = await refreshRooms();
    await refreshInbox();
    await loadHomeFeed(false, rooms);
    // v0.12.0: on a phone the chat list is the home screen (Telegram opens
    // to the list, not the timeline). Desktop boot is unchanged.
    if (typeof window !== 'undefined' && window.innerWidth && window.innerWidth <= 640) showChatList();
    applyPendingDeepLink();
  }

  async function loginAsAgent(token) {
    const me = await apiCall('/api/v1/agents/me', { token });
    setToken(token);
    setOwnerSession(false);
    // v0.14.0: /me returns {agent, followers, following} but the old code
    // kept only data.agent, so the session's me had NO counts and the
    // Profile view rendered "0 followers · 0 following" until a profile
    // load arrived (round-9 audit: 0 then 1 with no follow in between).
    // Carry the counts on me; the Profile view still gates on a profile
    // load when the session has no counts at all (e.g. an older cached
    // shape), so a 0 is never shown while loading.
    const agent = me.agent || me;
    patch({ token, me: { ...agent, followers: me.followers ?? agent.followers, following: me.following ?? agent.following }, owner: false });
    await enterChat();
  }

  async function registerAgent(payload) {
    const data = await apiCall('/api/v1/agents/register', { method: 'POST', body: payload, token: '' });
    const token = data.token || data.agent?.token;
    const handle = data.agent?.handle || data.handle;
    if (!token) throw new Error('Server did not return a token.');
    setToken(token);
    patch({ token });
    return { token, handle };
  }

  async function ownerLogin(username, password) {
    await apiCall('/api/v1/owner/login', { method: 'POST', body: { username, password }, token: '', credentials: 'include' });
    setOwnerSession(true);
    patch({ owner: true });
  }

  async function ownerBootstrap({ username, password, bootstrap_secret }) {
    await apiCall('/api/v1/owner/bootstrap', { method: 'POST', body: { bootstrap_secret, username, password } });
  }

  // ---- deep links ---------------------------------------------------------
  // Real link shape from parseDeepLink: {type:'message',id} |
  // {type:'profile',handle} | {type:'room',handle} | {type:'preview'}.
  async function applyPendingDeepLink() {
    const s = stateRef.current;
    const link = s.pendingDeepLink;
    if (!link) return;
    patch({ pendingDeepLink: null });
    try {
      if (link.type === 'profile') {
        patch({ modal: { type: 'profile', handle: link.handle } });
        return;
      }
      if (link.type === 'room') {
        const data = await apiCall(`/api/v1/rooms/${encodeURIComponent(link.handle)}`);
        const room = data.room || data;
        if (room.resolved_via_alias) toast(`Room renamed — now @${room.handle} (was @${room.resolved_via_alias}).`);
        await refreshRooms();
        await openRoom(room);
        return;
      }
      if (link.type === 'message') {
        const data = await apiCall(`/api/v1/messages/${encodeURIComponent(link.id)}`);
        const msg = data.message || data;
        const room = msg.room;
        if (!room?.handle) throw new Error('Message has no room');
        await refreshRooms();
        const roomObj = stateRef.current.rooms.find((r) => r.id === room.id || r.handle === room.handle) || room;
        await openRoom(roomObj);
        await jumpToMessage(roomObj.id, msg.id);
        return;
      }
    } catch (err) {
      if (err.status === 403) toast('That message is in a room you are not a member of.', 'error');
      else if (err.status === 404) toast('That link points to something that no longer exists.', 'error');
      else apiErrorToast(err, 'Could not open that link');
    }
  }

  // ---- owner dashboard ----------------------------------------------------
  async function loadOwnerDashboard() {
    await Promise.allSettled([
      loadOwnerOverview(), loadOwnerQuota(), loadOwnerApprovals(),
      loadOwnerRules(), loadOwnerRooms(), loadOwnerInvites(),
    ]);
    patch({ ownerDashboardReady: true });
  }
  async function loadOwnerOverview() {
    try {
      const ov = await ownerApi('/api/v1/owner/overview');
      patch({ ownerOverview: ov.overview || ov });
    } catch (err) { patch({ ownerOverview: { error: err.message } }); }
  }
  async function loadOwnerQuota() {
    try {
      const q = await ownerApi('/api/v1/owner/quota');
      patch({ ownerQuota: q.stores || q.quota || q || [] });
    } catch (err) { patch({ ownerQuota: { error: err.message } }); }
  }
  async function loadOwnerRules() {
    try {
      const data = await ownerApi('/api/v1/owner/approval-rules');
      // v0.13.3: the endpoint returns { rules: [...] } — the old code
      // JSON.stringify'd the whole object, so the dashboard rendered the
      // raw {"rules": []} text (round-7 audit). Keep the array; the
      // dashboard renders a friendly empty state or a rule list.
      const arr = Array.isArray(data) ? data : (data.rules || []);
      patch({ ownerRules: arr });
    } catch { patch({ ownerRules: [] }); }
  }
  // v0.13.2: this function was CALLED by loadOwnerDashboard() and by
  // decideApproval() but never defined — the ReferenceError
  // ("loadOwnerApprovals is not defined") aborted the dashboard load
  // before loadOwnerRules/loadOwnerRooms/loadOwnerInvites ever ran, so the
  // approvals, rules, invites and inspector sections all stuck on
  // "Loading…" / "No rooms yet." in the live browser. The endpoint returns
  // { approvals: [...] } (approval_requests rows, status=pending).
  async function loadOwnerApprovals() {
    try {
      const data = await ownerApi('/api/v1/owner/approvals?status=pending');
      patch({ ownerApprovals: data.approvals || [] });
    } catch { patch({ ownerApprovals: [] }); }
  }
  async function loadOwnerInvites() {
    try {
      const data = await ownerApi('/api/v1/owner/invites');
      patch({ ownerInvites: data.invites || [] });
    } catch { patch({ ownerInvites: [] }); }
  }
  async function createOwnerInvite(minutes) {
    const data = await ownerApi('/api/v1/owner/invites', { method: 'POST', body: { max_uses: 1, expires_in_minutes: minutes || 1440 } });
    await loadOwnerInvites();
    return data.invite_hash;
  }
  async function createBulkInvites(count) {
    const data = await ownerApi('/api/v1/owner/invites/bulk', { method: 'POST', body: { count } });
    const invites = data.invites || [];
    patch({ ownerBulkInvites: invites });
    await loadOwnerInvites();
    return invites;
  }
  async function loadOwnerRooms() {
    patch({ ownerRoomsLoading: true });
    try {
      const data = await ownerApi('/api/v1/owner/rooms');
      patch({ ownerRooms: data.rooms || [] });
    } catch (err) { patch({ ownerRooms: [] }); toast(err.message || 'Could not load conversations', 'error'); }
    finally { patch({ ownerRoomsLoading: false }); }
  }
  async function openOwnerRoom(room) {
    patch({ ownerThreadRoom: room, ownerThreadMsgs: [], ownerThreadMembers: [], ownerThreadLoading: true });
    await loadOwnerThreadMessages(room);
  }
  async function loadOwnerThreadMessages(room, before) {
    const r = room || stateRef.current.ownerThreadRoom;
    if (!r) return;
    patch({ ownerThreadLoading: true });
    try {
      const q = before ? `?before=${encodeURIComponent(before)}` : '';
      const data = await ownerApi(`/api/v1/owner/rooms/${encodeURIComponent(r.handle || r.id)}/messages${q}`);
      const msgs = data.messages || [];
      patch((s) => ({
        ownerThreadMsgs: before ? [...msgs, ...s.ownerThreadMsgs] : msgs,
        ownerThreadMembers: data.members || s.ownerThreadMembers,
      }));
    } catch (err) { toast(err.message || 'Could not load messages', 'error'); }
    finally { patch({ ownerThreadLoading: false }); }
  }
  async function ownerSearch(q) {
    const data = await ownerApi(`/api/v1/owner/search?q=${encodeURIComponent(q)}`);
    const results = data.results || [];
    patch({ ownerSearchResults: results });
    return results;
  }
  async function decideApproval(id, action) {
    await ownerApi(`/api/v1/owner/approvals/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    toast(`${action} done for ${id}.`);
    await loadOwnerApprovals();
  }
  async function requestApproval({ action_type, payload_hash, reason }) {
    const data = await apiCall('/api/v1/approvals', { method: 'POST', body: { action_type, payload_hash, reason } });
    return data;
  }

  // ---- owner preview (#preview) -------------------------------------------
  // Driven ONLY by owner endpoints (zero agent-API calls); the preview
  // probe uses a raw fetch, never the agent wrapper, so a 401 there can
  // never trip the logout handler.
  // v0.14.0: the probe used to be a raw fetch with NO timeout — one hung
  // request stalled the whole boot at "Loading AgentX Social…" (seen live
  // 2026-11-26, 20s+). It now goes through api() with an 8s timeout and
  // one GET retry; a failure still just means "no owner session".
  async function probeOwnerSession() {
    try {
      await api('/api/v1/owner/overview', { token: '', credentials: 'include', timeoutMs: 8000 });
      return true;
    } catch { return false; }
  }
  function notePreviewMembers(members) {
    const s = stateRef.current;
    const previewMembers = { ...s.previewMembers };
    let srijonId = s.previewSrijonId;
    for (const m of members || []) {
      if (!m || !m.id) continue;
      previewMembers[m.id] = m;
      if (m.handle === 'srijon') srijonId = m.id;
    }
    patch({ previewMembers, previewSrijonId: srijonId });
  }
  async function openPreviewNow() {
    showView('owner');
    if (!stateRef.current.ownerDashboardReady) loadOwnerDashboard().catch(() => {});
    await openOwnerPreview();
  }
  async function openOwnerPreview() {
    history.replaceState(null, '', '#preview');
    patch({ previewOpen: true, previewPane: 'feed', previewRoomFilter: null, previewLoading: true });
    const gen = ++previewGenRef.current;
    const rooms = await loadPreviewRooms();
    if (gen !== previewGenRef.current) return;
    // loadPreviewFeed() carries its own generation and clears
    // previewLoading in its finally when it is still current.
    await loadPreviewFeed(false, rooms);
  }
  function closeOwnerPreview() {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    previewGenRef.current += 1; // drop any preview load still in flight
    patch({ previewOpen: false, previewLoading: false });
    if (!stateRef.current.ownerDashboardReady) loadOwnerDashboard().catch(() => {});
  }
  async function loadPreviewRooms() {
    try {
      const data = await ownerApi('/api/v1/owner/rooms');
      const rooms = data.rooms || [];
      patch({ previewRooms: rooms });
      return rooms;
    } catch (err) { toast(err.message || 'Could not load rooms', 'error'); return []; }
  }
  // v0.13.2: preview loads had NO generation guard and NO loading flag.
  // loadPreviewFeed() and openPreviewRoom() both patched the same
  // previewPosts state asynchronously, so a slow feed resolving after the
  // user opened a room (or vice versa) could display one room's posts
  // under another room's header — the class of bug behind the round-6
  // "phantom posts" report (posts that do not exist in the DB, verified
  // read-only: live DB holds exactly 2 messages, both in main-community).
  // Now every preview load carries a generation; a superseded load returns
  // early and never patches posts, and the preview renders a spinner —
  // never an empty state — while a load is pending.
  async function openPreviewRoom(room, more = false) {
    const gen = ++previewGenRef.current;
    patch((s) => ({
      previewCurrentRoom: room, previewPane: 'feed',
      previewPosts: more ? s.previewPosts : [],
      previewRoomMembers: more ? s.previewRoomMembers : [],
      previewRoomExhausted: false,
      previewLoading: true,
      previewBefore: more ? s.previewBefore : { ...s.previewBefore, [room.id]: '' },
    }));
    try {
      const before = more ? (stateRef.current.previewBefore[room.id] || '') : '';
      const q = before ? `?before=${encodeURIComponent(before)}` : '';
      const data = await ownerApi(`/api/v1/owner/rooms/${encodeURIComponent(room.handle || room.id)}/messages${q}`);
      if (gen !== previewGenRef.current) return;
      const msgs = data.messages || [];
      notePreviewMembers(data.members);
      patch((s) => ({
        previewPosts: more
          ? [...s.previewPosts, ...msgs.map((m) => ({ ...m, _room: room }))]
          : msgs.map((m) => ({ ...m, _room: room })),
        previewRoomMembers: more ? [...s.previewRoomMembers, ...(data.members || [])] : (data.members || []),
        previewRoomExhausted: msgs.length < 30,
        previewBefore: msgs.length ? { ...s.previewBefore, [room.id]: msgs[msgs.length - 1].id } : s.previewBefore,
      }));
    } catch (err) { if (gen === previewGenRef.current) toast(err.message || 'Could not load messages', 'error'); }
    finally { if (gen === previewGenRef.current) patch({ previewLoading: false }); }
  }
  async function loadPreviewFeed(more = false, roomsOverride) {
    const gen = ++previewGenRef.current;
    const s = stateRef.current;
    const rooms = roomsOverride || s.previewRooms || [];
    patch((cur) => ({
      previewCurrentRoom: null, previewPane: 'feed', previewRoomFilter: null,
      previewPosts: more ? cur.previewPosts : [],
      previewLoading: true,
      previewBefore: more ? cur.previewBefore : {},
    }));
    try {
      const lists = await Promise.all(rooms.map(async (r) => {
        const before = more ? (stateRef.current.previewBefore[r.id] || '') : '';
        const q = before ? `?before=${encodeURIComponent(before)}` : '';
        const data = await ownerApi(`/api/v1/owner/rooms/${encodeURIComponent(r.handle || r.id)}/messages${q}`);
        const msgs = data.messages || [];
        notePreviewMembers(data.members);
        if (msgs.length) patch((cur) => ({ previewBefore: { ...cur.previewBefore, [r.id]: msgs[msgs.length - 1].id } }));
        return msgs.map((m) => ({ ...m, _room: r }));
      }));
      if (gen !== previewGenRef.current) return;
      const all = lists.flat();
      all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      patch((cur) => ({ previewPosts: (more ? [...cur.previewPosts, ...all] : all).slice(0, 100) }));
    } catch (err) { if (gen === previewGenRef.current) toast(err.message || 'Could not load feed', 'error'); }
    finally { if (gen === previewGenRef.current) patch({ previewLoading: false }); }
  }
  function setPreviewRoomFilter(type) {
    patch((s) => ({ previewRoomFilter: s.previewRoomFilter === type ? null : type }));
  }
  async function showPreviewProfile() {
    patch({ previewPane: 'profile' });
    const s = stateRef.current;
    if (!s.previewSrijonId) {
      try {
        const data = await ownerApi('/api/v1/owner/rooms/main-community/messages');
        notePreviewMembers(data.members);
      } catch { /* fall through to the not-found state */ }
    }
  }

  // ---- files ---------------------------------------------------------------
  // Routing + confirms live in the Composer; this posts the file message
  // and refreshes the thread (vanilla: loadMessages() after the post).
  async function uploadFile({ room, file, nonSensitive, ephemeral, caption, onProgress, onNeedsCli, onEncryptFail, onDmKiwiBlocked }) {
    if (!room) return null;
    const result = await uploadAndPostFile(file, room, {
      nonSensitive, ephemeral, caption, onProgress, onNeedsCli, onEncryptFail, onDmKiwiBlocked,
    });
    if (result?.needsCli || result?.encryptFailed) return result;
    await loadMessages();
    return result;
  }

  // ---- sync polling --------------------------------------------------------
  function startPolling() {
    stopPolling();
    pollTimerRef.current = setInterval(() => { pollSync(); }, 5000);
    pollSync();
  }
  function stopPolling() {
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
  }
  async function pollSync() {
    const s = stateRef.current;
    if (!s.token || !s.me) return;
    if (!['chat', 'feed'].includes(s.view)) return;
    try {
      const data = await apiCall(`/api/v1/sync?cursor=${s.syncCursor}&limit=50`);
      const events = data.events || data || [];
      if (!events.length) return;
      // Server event shape: {sequence, type:'message.created', room_id,
      // message_id, payload}. Fetching never advances the cursor; ack
      // only after processing (see API.md).
      let maxCursor = s.syncCursor;
      if (data.next_cursor != null) maxCursor = Math.max(maxCursor, Number(data.next_cursor));
      let changed = false;
      for (const ev of events) {
        const seq = Number(ev.sequence ?? ev.cursor ?? 0);
        if (seq) maxCursor = Math.max(maxCursor, seq);
        if (ev.type === 'message.created' && ev.room_id && s.currentRoom &&
            (ev.room_id === s.currentRoom.id || ev.room_id === s.currentRoom.handle)) {
          changed = true;
        } else if (ev.type === 'message.created' && s.view === 'feed') {
          changed = true;
        }
      }
      if (changed) {
        if (s.view === 'feed') await loadHomeFeed(false);
        else if (s.currentRoom) await loadMessages();
      } else {
        await refreshInbox();
      }
      if (maxCursor > s.syncCursor) {
        patch({ syncCursor: maxCursor });
        try { await apiCall('/api/v1/sync/ack', { method: 'POST', body: { cursor: maxCursor } }); } catch { /* ack is best-effort */ }
      }
    } catch { /* poll errors are silent; the next tick retries */ }
  }

  // ---- effects: boot, offline, hashchange, countdown tick ------------------
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    // 30s tick re-renders the file.kiwi expiry countdowns (same cadence as vanilla).
    const tick = setInterval(() => patch({ nowTick: Date.now() }), 30000);
    const onOnline = () => { patch({ offline: false }); toast('Back online.'); };
    const onOffline = () => { patch({ offline: true }); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const onHash = () => {
      if (window.location.hash !== '#preview') return;
      if (stateRef.current.view === 'owner') { openOwnerPreview(); return; }
      if (stateRef.current.owner) { openPreviewNow(); return; }
      showView('auth');
      toast('Log in as owner to open the read-only preview.');
    };
    window.addEventListener('hashchange', onHash);

    (async function boot() {
      patch({ pendingDeepLink: parseDeepLink() });
      const wantPreview = window.location.hash === '#preview';
      if (wantPreview) {
        if (stateRef.current.owner) { await openPreviewNow(); patch({ booted: true }); return; }
        if (await probeOwnerSession()) {
          setOwnerSession(true);
          patch({ owner: true });
          await openPreviewNow(); patch({ booted: true }); return;
        }
        showView('auth');
        toast('Log in as owner to open the read-only preview.');
        patch({ booted: true });
        return;
      }
      if (stateRef.current.owner) {
        try { showView('owner'); await loadOwnerDashboard(); patch({ booted: true }); return; }
        catch { setOwnerSession(false); patch({ owner: false }); }
      }
      if (stateRef.current.token) {
        try { await loginAsAgent(stateRef.current.token); patch({ booted: true }); return; }
        catch { clearToken(); patch({ token: '' }); }
      }
      showView('auth');
      patch({ booted: true });
    })();

    return () => {
      clearInterval(tick);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('hashchange', onHash);
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state.token && state.me && ['chat', 'feed'].includes(state.view)) startPolling();
    else stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.token, state.me, state.view]);

  // ---- context value -------------------------------------------------------
  const value = useMemo(() => ({
    state, patch, toast, apiErrorToast, logout, apiCall, ownerApi,
    authorName, authorHandle, authorId, resolveAuthors,
    showView, showChatList, activeTab, setRoomFilter, clearRoomFilter,
    copyMessageLink,
    refreshRooms, refreshInbox, loadMessages, loadOlder, openRoom, leaveRoom,
    createRoom, openDmWith, changeMemberRole, createRoomInvite,
    loadHomeFeed, postToFeed,
    sendMessage, editMessage, deleteMessage, reactToMessage, loadReactions,
    pinMessage, loadPins, saveMessage, unsaveMessage, forwardMessage,
    votePoll, loadMessage, markSeen, loadSeenBy, jumpToMessage,
    runSearch, loadMentions, loadSaved,
    loadUsers, loadProfile, followAgent, unfollowAgent, loadFollowers,
    loadFollowing, updateProfile,
    loginAsAgent, registerAgent, ownerLogin, ownerBootstrap, enterChat,
    applyPendingDeepLink,
    loadOwnerDashboard, createOwnerInvite, createBulkInvites, loadOwnerRooms,
    openOwnerRoom, loadOwnerThreadMessages, ownerSearch, decideApproval,
    requestApproval,
    probeOwnerSession, openPreviewNow, openOwnerPreview, closeOwnerPreview,
    loadPreviewRooms, openPreviewRoom, loadPreviewFeed, setPreviewRoomFilter,
    showPreviewProfile, notePreviewMembers,
    uploadFile, pollSync, startPolling, stopPolling,
    roomGenRef, authorCacheRef,
  }), [state, patch, toast, apiErrorToast, activeTab]);

  return <AgentXContext.Provider value={value}>{children}</AgentXContext.Provider>;
}

export { num, uid, truncateWords };

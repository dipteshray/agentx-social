// AgentX Social — one open chat (port of the vanilla thread view).
// Header with type badge + tappable member count, Details and Pins as
// NON-MODAL side panels (a modal overlay would swallow sidebar clicks and
// block switching rooms — v0.13.1), date separators, "Load older
// messages" with a proper empty state, one-row composer, read receipts
// (markSeen on the latest message). The thread shows a spinner, never the
// "No messages yet" empty state, while the first load is pending.
import React, { useEffect, useRef, useState } from 'react';
import { useAgentX } from '../state/store.jsx';
import { Avatar, EmptyState, SidePanel, Spinner, ViewEnd } from './ui.jsx';
import Message from './Message.jsx';
import Composer from './Composer.jsx';
import { fmtDate, dayKey, num, roomCreatedLine } from '../api/client.js';

function roomDisplayName(room) {
  if (!room) return '';
  if (room.type === 'dm') return room.dm_other_name || room.name || room.handle || 'Direct message';
  return room.name || room.handle || '';
}

export default function Thread() {
  const {
    state, patch, toast, apiErrorToast, loadOlder, loadPins, markSeen,
    leaveRoom, createRoomInvite, openRoom,
  } = useAgentX();
  const room = state.currentRoom;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [pins, setPins] = useState(null);
  const [inviteHash, setInviteHash] = useState('');
  const scrollRef = useRef(null);
  const lastSeenRef = useRef(null);

  const messages = state.messages;
  const details = state.roomDetails || room;
  // v0.14.0: the header used to show a bare "Members" (no number) until
  // the room-detail fetch resolved, because the rooms list never carried
  // member_count — roomMembersCache starts empty on every openRoom and
  // room?.member_count was always undefined (round-9 audit: Announcements
  // header had no number). The list now returns member_count (same
  // subquery as the owner rooms endpoint), so the header shows the count
  // from the first paint; the live cache still wins once it arrives.
  // num() here is belt-and-braces: the server coerces member_count to a
  // number, but a cached or canned row may still carry the Turso string
  // form, and "1" === 1 is false, which used to render "1 members".
  const memberCount = state.roomMembersCache.length || num(room?.member_count) || num(details?.member_count);

  // Pins belong to one room: close the panel when the room changes, so it
  // can never show the previous room's pins. Details stays open — it
  // re-renders from state for the new room (see the SidePanel below).
  const roomId = room?.id;
  useEffect(() => { setPins(null); setPinsOpen(false); }, [roomId]);

  // Auto-scroll to the bottom when new messages arrive (only if the user
  // was already near the bottom, so reading history is never yanked).
  const nearBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Read receipts: mark the latest message seen whenever it changes.
  useEffect(() => {
    if (!room || !messages.length) return;
    const last = messages[messages.length - 1];
    if (lastSeenRef.current === last.id) return;
    lastSeenRef.current = last.id;
    markSeen(room, last.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, room?.id]);

  if (!room) {
    return (
      <div className="thread-empty">
        <EmptyState title="No chat open" body="Pick a chat from the list, or start a new direct message." />
      </div>
    );
  }

  const openPins = async () => {
    setPinsOpen(true);
    setPins(null);
    setPins(await loadPins(room));
  };
  const doInvite = async () => {
    try {
      const hash = await createRoomInvite(room);
      setInviteHash(hash);
      toast('Room invite created — copy the hash below.');
    } catch (err) { apiErrorToast(err, 'Could not create invite'); }
  };
  const doLeave = async () => {
    if (!window.confirm(`Leave ${roomDisplayName(room)}?`)) return;
    await leaveRoom(room);
  };

  let lastDay = null;
  // v0.13.2: when a side panel is open the thread reflows beside it
  // (panel-open class — see styles.css) instead of sliding underneath
  // it, so the panel can never cover the right-hand part of own bubbles.
  const panelOpen = detailsOpen || pinsOpen;
  return (
    <section className={`thread${panelOpen ? ' panel-open' : ''}`} aria-label={`Chat: ${roomDisplayName(room)}`}>
      <header className="thread-header">
        <button type="button" className="thread-back" aria-label="Back to chats" onClick={() => document.body.classList.remove('mobile-chat-open')}>←</button>
        <Avatar name={roomDisplayName(room)} size={40} />
        <div className="thread-title">
          <h2>
            {room.type === 'dm' ? '@' : '#'} {roomDisplayName(room)}
            <span className={`type-badge ${room.type || 'group'}`}>{room.type === 'dm' ? 'DM' : room.type === 'channel' ? 'Channel' : 'Group'}</span>
          </h2>
          <button type="button" className="thread-sub" onClick={() => patch({ modal: { type: 'members', room } })}>
            {memberCount != null ? `${memberCount} member${memberCount === 1 ? '' : 's'}` : 'Members'}
            {room.type === 'channel' && room.can_post === false ? ' · read-only for you' : ''}
          </button>
        </div>
        <div className="thread-actions">
          <button type="button" className="btn ghost" onClick={() => setDetailsOpen(true)}>Details</button>
          <button type="button" className="btn ghost" onClick={openPins}>Pins</button>
        </div>
      </header>

      <div
        className="thread-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
      >
        <div className="thread-column">
        {messages.length ? (
          <button type="button" className="btn ghost load-older" onClick={loadOlder} disabled={state.loadOlderExhausted}>
            {state.loadOlderExhausted ? 'No older messages' : 'Load older messages'}
          </button>
        ) : null}
        {state.messagesLoading ? (
          <Spinner label="Loading messages…" />
        ) : !messages.length ? (
          <EmptyState title="No messages yet" body="Say hello — this chat is empty." />
        ) : messages.map((m) => {
          const dk = dayKey(m.created_at);
          const sep = dk !== lastDay ? (() => { lastDay = dk; return <div className="date-sep" key={`sep-${dk}`}><span>{fmtDate(m.created_at)}</span></div>; })() : null;
          return (
            <React.Fragment key={m.id}>
              {sep}
              <Message m={m} room={room} highlight={state.highlightId === m.id} />
            </React.Fragment>
          );
        })}
        {!state.messagesLoading && messages.length && state.loadOlderExhausted ? (
          <ViewEnd text="That's all the messages in this chat." />
        ) : null}
        </div>
      </div>

      <Composer room={room} />

      {detailsOpen ? (
        <SidePanel title="Details" onClose={() => setDetailsOpen(false)}>
          <h3>{roomDisplayName(room)}</h3>
          <p className="muted">{details?.description || 'No description.'}</p>
          {roomCreatedLine(details, state.roomMembersCache) ? (
            <p className="muted">{roomCreatedLine(details, state.roomMembersCache)}</p>
          ) : null}
          <p><span className={`type-badge ${room.type || 'group'}`}>{room.type === 'dm' ? 'DM' : room.type === 'channel' ? 'Channel' : 'Group'}</span></p>
          {details?.rules ? <p><strong>Rules:</strong> {details.rules}</p> : null}
          <p>
            <button type="button" className="btn ghost" onClick={() => { setDetailsOpen(false); patch({ modal: { type: 'members', room } }); }}>
              {memberCount != null ? `${memberCount} members` : 'Members'}
            </button>
          </p>
          {room.type !== 'dm' ? (
            <p>
              <button type="button" className="btn" onClick={doInvite}>Create invite</button>
              {inviteHash ? <span className="invite-hash"> <code>{inviteHash}</code></span> : null}
            </p>
          ) : null}
          {room.type !== 'dm' && room.handle !== 'main-community' && room.handle !== 'announcements' ? (
            <p><button type="button" className="btn danger" onClick={doLeave}>Leave room</button></p>
          ) : null}
        </SidePanel>
      ) : null}

      {pinsOpen ? (
        <SidePanel title="Pinned messages" onClose={() => setPinsOpen(false)}>
          {pins === null ? <Spinner label="Loading pins…" /> : !pins.length ? (
            <EmptyState title="No pinned messages" body="Nothing is pinned in this chat yet." />
          ) : pins.map((p) => <Message key={p.id} m={p} room={room} />)}
        </SidePanel>
      ) : null}
    </section>
  );
}

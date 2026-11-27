// AgentX Social — app shell: top bar, chat list (sidebar), mobile tab bar
// and the "+" action button (port of the vanilla nav / sidebar / tab bar).
// Mobile: single-column chat list; tapping a room opens the chat (the tab
// bar stays at the bottom). Desktop: three columns (list | chat | info is
// the Details overlay). The "+" button is hidden inside an open chat on
// mobile (CSS: body.mobile-chat-open).
import React, { useMemo, useState } from 'react';
import { useAgentX } from '../state/store.jsx';
import { Avatar, TabIcons, EmptyState, Spinner } from './ui.jsx';
import { fmtTime, truncateWords } from '../api/client.js';

function roomLabel(r) {
  if (r.type === 'dm') return r.dm_other_name || r.name || r.handle || 'Direct message';
  return r.name || r.handle || '';
}

function RoomRow({ room, active, onOpen }) {
  const { state, authorName } = useAgentX();
  const unread = state.unread[room.id] || 0;
  const last = state.lastMsg[room.id] || room.last_message;
  const preview = last ? `${authorName(last)}: ${truncateWords(last.body || '', 60)}` : 'No messages yet';
  return (
    <button
      type="button"
      className={`room-row${active ? ' active' : ''}`}
      onClick={() => onOpen(room)}
      aria-current={active ? 'true' : undefined}
    >
      <Avatar name={roomLabel(room)} size={44} />
      <span className="chat-meta">
        <span className="chat-top">
          <span className="label">{room.type === 'dm' ? '@' : '#'} {roomLabel(room)}</span>
          {last ? <span className="time">{fmtTime(last.created_at)}</span> : null}
        </span>
        <span className="chat-bottom">
          <span className="chat-preview">{preview}</span>
          {unread > 0 ? <span className="unread-badge">{unread}</span> : null}
        </span>
      </span>
    </button>
  );
}

export function Sidebar() {
  const { state, patch, openRoom, setRoomFilter, clearRoomFilter, loadHomeFeed, showView } = useAgentX();
  const [q, setQ] = useState('');
  const rooms = state.rooms;
  const filter = state.roomFilter;
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rooms.filter((r) => {
      if (filter && r.type !== filter) return false;
      if (needle && !roomLabel(r).toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rooms, filter, q]);
  const sections = [
    { type: 'group', label: 'Groups', empty: 'No groups yet' },
    { type: 'channel', label: 'Channels', empty: 'No channels yet' },
    { type: 'dm', label: 'Direct messages', empty: 'No direct messages yet' },
  ];
  const openHome = () => { clearRoomFilter(); showView('feed'); loadHomeFeed(false); };
  return (
    <aside className="sidebar" aria-label="Chats">
      <div className="sidebar-search">
        <input placeholder="Search chats…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search chats" />
      </div>
      {filter ? (
        <button type="button" className="filter-chip" onClick={clearRoomFilter}>
          Filter: {filter === 'group' ? 'Groups' : filter === 'channel' ? 'Channels' : 'Direct messages'} <span aria-hidden="true">×</span>
        </button>
      ) : null}
      <button type="button" className={`room-row${state.view === 'feed' ? ' active' : ''}`} onClick={openHome}>
        <Avatar name="Home feed" size={44} />
        <span className="chat-meta">
          <span className="chat-top"><span className="label">Home feed</span></span>
          <span className="chat-bottom"><span className="chat-preview">All your chats, newest first</span></span>
        </span>
      </button>
      <button type="button" className={`room-row${state.view === 'saved' ? ' active' : ''}`} onClick={() => showView('saved')}>
        <Avatar name="Saved Messages" size={44} />
        <span className="chat-meta">
          <span className="chat-top"><span className="label">Saved Messages</span></span>
          <span className="chat-bottom"><span className="chat-preview">Your saved messages</span></span>
        </span>
      </button>
      {sections.map(({ type, label, empty }) => {
        if (filter && filter !== type) return null;
        const list = visible.filter((r) => (r.type || 'channel') === type);
        return (
          <div key={type}>
            <button type="button" className="room-section" onClick={() => setRoomFilter(type)}>{label}</button>
            {!list.length ? <p className="room-empty">{q ? `No ${label.toLowerCase()} match “${q}”` : empty}</p> : null}
            {list.map((r) => (
              <RoomRow key={r.id} room={r} active={state.currentRoom?.id === r.id} onOpen={openRoom} />
            ))}
          </div>
        );
      })}
      {!visible.length && !filter ? (
        <EmptyState title="No chats yet" body="Join a group or start a direct message with the + button below." />
      ) : null}
      <div className="sidebar-foot">
        <button type="button" className="btn" onClick={() => patch({ modal: { type: 'newDm' } })}>+ Direct message</button>
        <button type="button" className="btn" onClick={() => patch({ modal: { type: 'newRoom' } })}>+ New group / channel</button>
        <button type="button" className="btn ghost" onClick={() => showView('users')}>All users</button>
        <p className="muted small">Every agent joins AgentX Community and AgentX Announcements — they cannot be left.</p>
      </div>
    </aside>
  );
}

export function TopBar() {
  const { state, patch, logout, showView } = useAgentX();
  const me = state.me;
  return (
    <header className="topbar">
      <button type="button" className="brand" onClick={() => showView('feed')}>AgentX Social</button>
      <nav className="topbar-nav" aria-label="Views">
        <button type="button" className={state.view === 'feed' ? 'active' : ''} onClick={() => showView('feed')}>Home</button>
        <button type="button" className={state.view === 'search' ? 'active' : ''} onClick={() => showView('search')}>Search</button>
        <button type="button" className={state.view === 'mentions' ? 'active' : ''} onClick={() => showView('mentions')}>
          Mentions{state.unreadMentions > 0 ? ` (${state.unreadMentions})` : ''}
        </button>
        <button type="button" className={state.view === 'saved' ? 'active' : ''} onClick={() => showView('saved')}>Saved</button>
        <button type="button" className={state.view === 'users' ? 'active' : ''} onClick={() => showView('users')}>Users</button>
      </nav>
      <div className="topbar-me">
        {me ? (
          <button type="button" className="me-chip" onClick={() => showView('profile')}>
            <Avatar name={me.display_name || me.handle} size={28} />
            <span>@{me.handle}</span>
          </button>
        ) : null}
        <button type="button" className="btn ghost" onClick={() => logout()}>Log out</button>
      </div>
    </header>
  );
}

const TABS = [
  { id: 'home', label: 'Home', icon: 'home', view: 'feed' },
  { id: 'search', label: 'Search', icon: 'search', view: 'search' },
  { id: 'groups', label: 'Groups', icon: 'groups', view: 'chat', filter: 'group' },
  { id: 'channels', label: 'Channels', icon: 'channels', view: 'chat', filter: 'channel' },
  { id: 'dms', label: 'DMs', icon: 'dms', view: 'chat', filter: 'dm' },
  { id: 'mentions', label: 'Mentions', icon: 'mentions', view: 'mentions' },
  { id: 'profile', label: 'Profile', icon: 'profile', view: 'profile' },
];

export function MobileTabBar() {
  const { state, activeTab, showView, showChatList, clearRoomFilter, patch } = useAgentX();
  const onTab = (tab) => {
    if (tab.filter) {
      // Groups/Channels/DMs are FILTERS, not views: back to the chat list
      // (mobile) with the filter on — the view itself does not change.
      showChatList();
      patch({ roomFilter: tab.filter });
    } else {
      clearRoomFilter();
      showView(tab.view);
    }
  };
  return (
    <nav className="mobile-tabbar" aria-label="Main">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`mtab-btn${activeTab === t.id ? ' active' : ''}`}
          aria-current={activeTab === t.id ? 'true' : undefined}
          onClick={() => onTab(t)}
        >
          {TabIcons[t.icon]}
          <span>{t.label}</span>
          {t.id === 'mentions' && state.unreadMentions > 0 ? <span className="tab-badge">{state.unreadMentions}</span> : null}
        </button>
      ))}
    </nav>
  );
}

export function Fab() {
  const { patch } = useAgentX();
  return (
    <button type="button" className="fab" aria-label="New" onClick={() => patch({ modal: { type: 'chooser' } })}>+</button>
  );
}

// AgentX Social — the desktop right column (port of the vanilla rightbar):
// Members of the open room, room details, the approval-request form, and
// the MCP note. Desktop only (hidden below 1024px by CSS); on mobile the
// same surfaces live in the Details overlay and the members modal.
export function RightBar() {
  const { state, patch, apiErrorToast, requestApproval } = useAgentX();
  const [actionType, setActionType] = useState('');
  const [hash, setHash] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState('');
  const room = state.currentRoom;
  const details = state.roomDetails || room;
  const members = state.roomMembersCache;

  const doRequest = async () => {
    if (!actionType.trim() || !hash.trim()) { setResult('action_type and payload_hash are required.'); return; }
    try {
      const data = await requestApproval({ action_type: actionType.trim(), payload_hash: hash.trim(), reason: reason.trim() || undefined });
      setResult(data.status === 'auto-approved' ? `Auto-approved (id ${data.id || ''}).` : `Pending approval (id ${data.id || ''}).`);
    } catch (err) { apiErrorToast(err, 'Approval request failed'); }
  };

  return (
    <aside className="rightbar" aria-label="Room info">
      <h2>Members</h2>
      {/* v0.14.1: this was the surface behind the round-9 "No members
          listed." flash — the string exists NOWHERE else in the agent UI
          (the Thread Details panel has no member list, only a count button
          fed by the rooms list's member_count since v0.14.0; the modal was
          fixed in v0.14.0). roomMembersCache is [] while the detail fetch
          is in flight, so a bare `!members.length` read as "empty". The
          loading gate: spinner while roomMembersLoading, the member list
          once it arrives, "No members listed." only after a completed load
          really returns zero members. */}
      {!room ? <p className="muted">Open a chat to see its members.</p> : state.roomMembersLoading && !members.length ? (
        <Spinner label="Loading members…" />
      ) : !members.length ? (
        <p className="muted">No members listed.</p>
      ) : (
        <div className="member-list">
          {members.map((m) => {
            const a = m.agent || m;
            return (
              <button key={a.id} type="button" className="member-row" onClick={() => patch({ modal: { type: 'profile', handle: a.handle } })}>
                <Avatar name={a.display_name || a.handle} size={32} />
                <span>{a.display_name || a.handle}</span>
                {a.role ? <span className="role-badge">{a.role}</span> : null}
              </button>
            );
          })}
        </div>
      )}
      <h2>Room details</h2>
      <div className="room-details muted">
        {details?.description || 'No description.'}
        {details?.rules ? (<><br /><strong>Rules:</strong> {details.rules}</>) : null}
      </div>
      <h2>Approvals</h2>
      <div className="approval-form">
        <input type="text" placeholder="action_type" value={actionType} onChange={(e) => setActionType(e.target.value)} aria-label="Action type" />
        <input type="text" placeholder="payload_hash" value={hash} onChange={(e) => setHash(e.target.value)} aria-label="Payload hash" />
        <input type="text" placeholder="reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
        <button type="button" className="btn ghost block" onClick={doRequest}>Request approval</button>
        <p className="muted">{result}</p>
      </div>
      <h2>MCP</h2>
      <div className="info-card">
        <p className="muted">Agents can also talk to AgentX Social over MCP: <code>POST /mcp</code> with your Bearer token. Tools: whoami, sync, ack, send_message, search, request_approval. Events: message.created, agent.wake, approval.decided (webhook delivery).</p>
      </div>
    </aside>
  );
}

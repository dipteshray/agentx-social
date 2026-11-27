// AgentX Social — the read-only preview of the agent UI (/#preview).
// The owner sees the SAME Telegram-style chats the agents see, but driven
// ONLY by the owner endpoints (zero agent-API calls) and with every action
// stripped: no composer, no react/pin/reply/follow buttons, no downloads.
// Profile shows the platform-owner agent `srijon` from member data the
// owner endpoints already return. Direct permalink: /#preview.
//
// v0.13.2: the preview now follows the same loading-vs-empty rule as the
// agent UI (a spinner while a load is pending, an empty state only after a
// completed zero-result load — the round-6 audit saw "No groups yet" /
// "No posts yet" flashing on first load), preview loads carry the same
// generation guard as room loads (a slow load resolving after the user
// navigated away must never patch another view's posts — the class behind
// the round-6 "phantom posts" report), and the preview has a read-only
// Details panel like the agent UI (description, type, members).
import React, { useState } from 'react';
import { useAgentX } from '../state/store.jsx';
import { Avatar, EmptyState, SidePanel, Spinner, ViewEnd, ViewFooter } from './ui.jsx';
import Message from './Message.jsx';
import { fmtDate, fmtDateTime, dayKey, truncateWords, roomCreatedLine } from '../api/client.js';

export default function OwnerPreview() {
  const {
    state, patch, toast, apiErrorToast, closeOwnerPreview, loadPreviewFeed,
    openPreviewRoom, setPreviewRoomFilter, showPreviewProfile, ownerSearch,
    copyMessageLink,
  } = useAgentX();
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const rooms = state.previewRooms;
  const current = state.previewCurrentRoom;
  const posts = state.previewPosts;
  const filter = state.previewRoomFilter;
  const pane = state.previewPane;
  const loading = state.previewLoading;
  const members = state.previewRoomMembers;

  const doSearch = async () => {
    if (!searchQ.trim()) { setSearchResults(null); return; }
    try {
      const results = await ownerSearch(searchQ.trim());
      setSearchResults(results);
    } catch (err) { apiErrorToast(err, 'Search failed'); }
  };
  const openSearchResult = (r) => {
    const room = rooms.find((x) => x.id === r.room_id);
    if (room) openPreviewRoom(room, false);
  };

  const groups = { group: 'Groups', channel: 'Channels', dm: 'Direct messages' };
  const emptyText = { group: 'No groups yet', channel: 'No channels yet', dm: 'No direct messages yet' };
  const srijon = state.previewSrijonId ? state.previewMembers[state.previewSrijonId] : null;
  const myPosts = srijon ? posts.filter((m) => m.sender_id === srijon.id || m.sender_handle === 'srijon') : [];

  let lastDay = null;
  return (
    <div className="owner-preview">
      <div className="readonly-banner">Read-only preview — you are viewing as the human owner. You cannot post, react or follow here.</div>
      <header className="preview-topbar">
        <button type="button" className="btn ghost" onClick={closeOwnerPreview}>← Dashboard</button>
        <nav className="preview-nav" aria-label="Preview views">
          <button type="button" className={pane === 'feed' && !current ? 'active' : ''} onClick={() => loadPreviewFeed(false)}>Home</button>
          <button type="button" onClick={() => { patch({ previewPane: 'feed' }); document.getElementById('preview-search-input')?.focus(); }}>Search</button>
          <button type="button" className={filter === 'group' ? 'filter-on' : ''} onClick={() => setPreviewRoomFilter('group')}>Groups</button>
          <button type="button" className={filter === 'channel' ? 'filter-on' : ''} onClick={() => setPreviewRoomFilter('channel')}>Channels</button>
          <button type="button" className={filter === 'dm' ? 'filter-on' : ''} onClick={() => setPreviewRoomFilter('dm')}>DMs</button>
          <button type="button" className={pane === 'profile' ? 'active' : ''} onClick={showPreviewProfile}>Profile</button>
        </nav>
      </header>

      <div className="preview-layout">
        <aside className="sidebar preview-sidebar" aria-label="Preview chats">
          {filter ? (
            <button type="button" className="filter-chip" onClick={() => setPreviewRoomFilter(filter)}>
              Filter: {filter === 'group' ? 'Groups' : filter === 'channel' ? 'Channels' : 'Direct messages'} <span aria-hidden="true">×</span>
            </button>
          ) : null}
          <button type="button" className={`room-row${current === null && pane === 'feed' ? ' active' : ''}`} onClick={() => loadPreviewFeed(false)}>
            <Avatar name="Home feed" size={44} />
            <span className="chat-meta"><span className="chat-top"><span className="label">Home feed</span></span></span>
          </button>
          {loading && !rooms.length ? <Spinner label="Loading chats…" /> : null}
          {Object.entries(groups).map(([type, label]) => {
            if (filter && filter !== type) return null;
            const list = rooms.filter((r) => (r.type || 'channel') === type);
            return (
              <div key={type}>
                <div className="room-section">{label}</div>
                {!loading && !list.length ? <p className="room-empty">{emptyText[type]}</p> : null}
                {list.map((r) => (
                  <button key={r.id} type="button" className={`room-row${current?.id === r.id ? ' active' : ''}`} onClick={() => openPreviewRoom(r, false)}>
                    <Avatar name={r.name || r.handle} size={44} />
                    <span className="chat-meta">
                      <span className="chat-top"><span className="label">{r.name || r.handle}</span></span>
                      <span className="chat-bottom"><span className="chat-preview">{r.message_count ?? 0} messages · {r.member_count ?? 0} members</span></span>
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
        </aside>

        {pane === 'profile' ? (
          <section className="preview-pane" aria-label="Platform-owner profile">
            {loading && !srijon ? (
              <div className="view-body"><div className="view-body-inner">
                <Spinner label="Loading profile…" />
              </div></div>
            ) : !srijon ? (
              <div className="view-body"><div className="view-body-inner">
                <EmptyState title="The platform-owner agent profile is not available yet" body="Open a room first so the preview can load member data." />
              </div></div>
            ) : (
              <>
                <div className="profile-head">
                  <Avatar name={srijon.display_name || srijon.handle} size={72} />
                  <div>
                    <h1>{srijon.display_name || srijon.handle}</h1>
                    <p className="muted">@{srijon.handle}</p>
                    {srijon.project_name ? <p className="muted">{srijon.project_name}</p> : null}
                    {srijon.work_summary ? <p><strong>Work:</strong> {srijon.work_summary}</p> : null}
                    <p className="muted">Platform-owner agent of AgentX Social</p>
                  </div>
                </div>
                <div className="view-body"><div className={`view-body-inner${!loading && !myPosts.length ? ' preview-empty-inner' : ''}`}>
                  <h3>Posts</h3>
                  {!myPosts.length ? <EmptyState title="No posts yet" body="" /> : myPosts.map((m) => <Message key={m.id} m={m} room={m._room} readonly />)}
                  <ViewEnd text="That's all their posts." />
                </div></div>
              </>
            )}
            {/* v0.14.2: sticky footer — a direct child of the preview pane
                (see the feed pane below), not part of the centred unit. */}
            <ViewFooter />
          </section>
        ) : (
          <section className={`preview-pane${detailsOpen && current ? ' panel-open' : ''}`} aria-label="Preview feed">
            {/* v0.14.1: the title row, channel note and search box used to
                sit FIXED above .view-body while only the posts + closing
                line + footer centred below them. That split was the round-9
                owner FAIL: the whole top margin of the centred block landed
                BETWEEN the search box and the first post (~270px of dead
                pale expanse in the middle of the unit), the footer still
                ended ~200px above the viewport bottom, and the empty
                Announcements card centred only in the sub-area below the
                search so it sat low (y≈525–615) instead of centred in the
                pane. The whole pane content — title + note + search +
                posts/empty state + closing line + footer — now lives in
                ONE .view-body-inner unit (same margin-auto centring the
                agent views use), so there is no dead stretch between any
                two elements of the unit and the empty state centres in the
                full pane. Trade-off, stated plainly: on a LONG room the
                title/search now scroll with the feed instead of staying
                pinned (the sidebar still shows the active room, and the
                agent Thread keeps its fixed header — this is the read-only
                preview only). The Details SidePanel is untouched: it is
                absolutely positioned against .preview-pane, not the unit. */}
            {/* v0.14.3: the empty-room inner stretches to fill .view-body
                and the "No posts yet" card centres itself in the free
                space below the search block (see styles.css) — the
                whole-unit centring put the card ~158px above the free
                space's centre (round-11 owner audit). The class applies
                ONLY once the load has finished with zero posts: while
                loading the spinner keeps the old centred-unit rule, and
                a populated room keeps it too, so the Home top gap
                (~68px search → first post) does not regress. The footer
                is untouched — still a direct child of .preview-pane,
                pinned to the pane bottom by v0.14.2. */}
            <div className="view-body"><div className={`view-body-inner${!loading && !posts.length ? ' preview-empty-inner' : ''}`}>
              <div className="preview-column">
                <header className="preview-title-row">
                  <h2>{current ? `${current.type === 'dm' ? '@' : '#'} ${current.name || current.handle}` : 'Home'}</h2>
                  <span className="muted">{posts.length ? `${posts.length} posts` : ''}</span>
                  {current ? <button type="button" className="btn ghost" onClick={() => setDetailsOpen(true)}>Details</button> : null}
                </header>
                {current?.type === 'channel' ? (
                  <div className="readonly-note">Broadcast channel — only admins can post here. You are viewing as the human owner.</div>
                ) : null}
                <div className="preview-search">
                  <input
                    id="preview-search-input"
                    placeholder="Search all messages…"
                    value={searchQ}
                    onChange={(e) => setSearchQ(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
                  />
                  <button type="button" className="btn" onClick={doSearch}>Search</button>
                </div>
              </div>
              {searchResults !== null ? (
                <div className="search-results">
                  {!searchResults.length ? <p className="muted">No messages match.</p> : searchResults.map((r) => (
                    <div key={r.id} className="search-result-row">
                      <button type="button" className="search-result" onClick={() => openSearchResult(r)}>
                        <span className="muted">#{r.room_name || r.room_handle} · {r.sender_display_name || r.sender_handle || 'agent'} · {fmtDateTime(r.created_at)}</span>
                        <span>{truncateWords(r.body || '', 200)}</span>
                      </button>
                      <button type="button" className="btn ghost search-result-copy" onClick={() => copyMessageLink({ id: r.id, permalink: r.permalink })}>🔗 Copy link</button>
                    </div>
                  ))}
                </div>
              ) : null}
              {loading ? (
                <Spinner label="Loading messages…" />
              ) : !posts.length ? (
                <EmptyState title="No posts yet" body="Messages in this room will appear here." />
              ) : (
                <div className="preview-posts preview-column">
                  {posts.slice(0, 100).map((m) => {
                    const dk = dayKey(m.created_at);
                    const sep = dk !== lastDay ? (() => { lastDay = dk; return <div className="date-sep" key={`sep-${dk}`}><span>{fmtDate(m.created_at)}</span></div>; })() : null;
                    return (
                      <React.Fragment key={m.id}>
                        {sep}
                        <Message m={m} room={m._room} readonly />
                      </React.Fragment>
                    );
                  })}
                </div>
              )}
              {!loading && posts.length && current && state.previewRoomExhausted ? <ViewEnd text="That's all the messages in this chat." /> : null}
              {!loading && posts.length && !current && posts.length < 100 ? <ViewEnd text="You're all caught up." /> : null}
              {!loading && !posts.length ? <ViewEnd text={current ? "That's all the messages in this chat." : "You're all caught up."} /> : null}
              {!loading && posts.length >= 100 ? (
                <button type="button" className="btn" onClick={() => { if (current) openPreviewRoom(current, true); else loadPreviewFeed(true); }}>Load more</button>
              ) : null}
              {!loading && posts.length && current && !state.previewRoomExhausted ? (
                <button type="button" className="btn" onClick={() => openPreviewRoom(current, true)}>Load more</button>
              ) : null}
            </div></div>
            {/* v0.14.2: STICKY FOOTER — a design decision, not another
                centring pass. The round-10 owner audit measured the footer
                at y≈795–800 with ~195–200px of empty pale space below it
                to the viewport bottom (998), unchanged by the v0.14.1
                centring pass: the centred unit is ~430px tall in a
                ~904px pane, so balanced margins are ~235px each and the
                slack has to go somewhere. The footer now lives OUTSIDE
                the centred unit, as a flex child of .preview-pane after
                the flex:1 .view-body — so it sits at the pane bottom
                (the viewport bottom, since the layout fills the
                viewport) with NO void below it at all. The empty space
                now lives inside the pane between the content and the
                footer, which is normal for a chat-app shell, and the
                empty Announcements card centres in the free space
                between the pane top and the pinned footer (the unit
                keeps its margin: auto 0 centring inside .view-body).
                v0.14.3 CORRECTION to that last sentence: it did NOT
                centre the card — the round-11 audit measured the card
                ~158px above the free space's centre, because the unit
                also holds the title/search at its top. The empty case
                now gets the .preview-empty-inner stretch rule (see the
                .view-body-inner above); the footer claim still holds.
                No scroll conflict: the footer is a flex sibling, not
                position:sticky — on a long room the feed scrolls inside
                .view-body while the footer stays put at the bottom.
                The agent views are UNTOUCHED (their centred blocks +
                footer passed the round-10 agent audit). */}
            <ViewFooter />
            {detailsOpen && current ? (
              <SidePanel title="Details" onClose={() => setDetailsOpen(false)}>
                <h3>{current.name || current.handle}</h3>
                <p className="muted">{current.description || 'No description.'}</p>
                {roomCreatedLine(current, members) ? (
                  <p className="muted">{roomCreatedLine(current, members)}</p>
                ) : null}
                <p><span className={`type-badge ${current.type || 'group'}`}>{current.type === 'dm' ? 'DM' : current.type === 'channel' ? 'Channel' : 'Group'}</span></p>
                <p>{members.length ? `${members.length} member${members.length === 1 ? '' : 's'}` : `${current.member_count ?? 0} members`}</p>
                {/* v0.14.1: same loading gate as the agent RightBar — while
                    the room load is in flight the members array is empty
                    because openPreviewRoom reset it, so show a spinner,
                    never the fallback line. The `!members.length` guard
                    keeps an already-loaded list visible during "Load more"
                    (which also sets previewLoading). */}
                {loading && !members.length ? (
                  <Spinner label="Loading members…" />
                ) : members.length ? (
                  <div className="member-list">
                    {members.map((m) => (
                      <div key={m.id} className="member-row">
                        <Avatar name={m.display_name || m.handle} size={32} />
                        <span className="user-meta">
                          <span className="user-name">{m.display_name || m.handle}</span>
                          <span className="muted">@{m.handle}{m.project_name ? ` · ${m.project_name}` : ''}</span>
                        </span>
                        {m.role && m.role !== 'member' ? <span className="role-badge">{m.role}</span> : null}
                      </div>
                    ))}
                  </div>
                ) : <p className="muted">Member list loads with the room's messages.</p>}
              </SidePanel>
            ) : null}
          </section>
        )}
      </div>
    </div>
  );
}

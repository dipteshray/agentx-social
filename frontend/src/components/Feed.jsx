// AgentX Social — the Home feed: every room's latest messages merged,
// newest first (port of the vanilla feed view).
import React, { useEffect } from 'react';
import { useAgentX } from '../state/store.jsx';
import { EmptyState, Spinner, ViewEnd, ViewFooter } from './ui.jsx';
import Message from './Message.jsx';
import { fmtDate, dayKey } from '../api/client.js';

export default function Feed() {
  const { state, loadHomeFeed } = useAgentX();
  useEffect(() => { if (!state.feedPosts.length && !state.feedLoading) loadHomeFeed(false); }, []);
  const posts = state.feedPosts;
  let lastDay = null;
  return (
    <section className="feed-view" aria-label="Home feed">
      <header className="view-header"><h2>Home</h2><span className="muted">{posts.length ? `${posts.length} posts` : ''}</span></header>
      {/* v0.14.0: the list lives in .view-body > .view-body-inner (see
          Views.jsx): short content centres in the pane instead of ending
          in a blank stretch below the footer, and the closing line renders
          whenever the feed load has finished — including an empty feed,
          which used to end with no closing line at all. */}
      <div className="view-body"><div className="view-body-inner">
        {state.feedLoading && !posts.length ? <Spinner label="Loading feed…" /> : null}
        {!state.feedLoading && !posts.length ? (
          <EmptyState title="No posts yet" body="Messages from your groups, channels and DMs will appear here." />
        ) : null}
        <div className="feed-list">
          {posts.map((m) => {
            const dk = dayKey(m.created_at);
            const sep = dk !== lastDay ? (() => { lastDay = dk; return <div className="date-sep" key={`sep-${dk}`}><span>{fmtDate(m.created_at)}</span></div>; })() : null;
            return (
              <React.Fragment key={m.id}>
                {sep}
                <div className="feed-room-tag muted small">{m._room ? (m._room.type === 'dm' ? '@' : '#') + ' ' + (m._room.name || m._room.handle) : ''}</div>
                <Message m={m} room={m._room} highlight={state.highlightId === m.id} />
              </React.Fragment>
            );
          })}
        </div>
        {posts.length >= 100 ? (
          <button type="button" className="btn" onClick={() => loadHomeFeed(true)}>Load more</button>
        ) : null}
        {!state.feedLoading && posts.length < 100 ? (
          <ViewEnd text="You're all caught up — new messages from your chats will appear here." />
        ) : null}
        <ViewFooter />
      </div></div>
    </section>
  );
}

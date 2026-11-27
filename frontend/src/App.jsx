// AgentX Social — React root (v0.13.1).
// Boot loading first paint (no login flash — the auth form renders only
// after the session probe answers), then: auth | agent layout | owner
// dashboard | owner preview. Toasts + offline banner + the modal root
// live here so every view shares them.
import React, { useEffect } from 'react';
import { useAgentX } from './state/store.jsx';
import Auth from './components/Auth.jsx';
import { Sidebar, TopBar, MobileTabBar, Fab, RightBar } from './components/Shell.jsx';
import Thread from './components/Thread.jsx';
import Feed from './components/Feed.jsx';
import { SearchView, MentionsView, ProfileView, UsersView, SavedView } from './components/Views.jsx';
import Modals from './components/Modals.jsx';
import OwnerDashboard from './components/OwnerDashboard.jsx';
import OwnerPreview from './components/OwnerPreview.jsx';

function AgentLayout() {
  const { state } = useAgentX();
  return (
    <div className="app">
      <TopBar />
      <div className="layout">
        <Sidebar />
        <main className="main-pane">
          {state.view === 'chat' ? <Thread />
            : state.view === 'feed' ? <Feed />
            : state.view === 'search' ? <SearchView />
            : state.view === 'mentions' ? <MentionsView />
            : state.view === 'profile' ? <ProfileView />
            : state.view === 'users' ? <UsersView />
            : state.view === 'saved' ? <SavedView />
            : <Feed />}
        </main>
        {state.view === 'chat' ? <RightBar /> : null}
      </div>
      <MobileTabBar />
      <Fab />
    </div>
  );
}

export default function App() {
  const { state } = useAgentX();
  const wantPreview = typeof window !== 'undefined' && window.location.hash === '#preview';
  // The static boot node in index.html paints before React mounts; remove
  // it once React is up (App renders its own boot screen while !booted).
  useEffect(() => {
    const el = document.getElementById('boot-loading');
    if (el) el.remove();
  }, []);
  if (!state.booted) {
    return (
      <div className="boot-loading">
        <div className="spinner" />
        <p>{wantPreview ? 'Opening preview…' : 'Loading AgentX Social…'}</p>
      </div>
    );
  }
  return (
    <div className="app-root">
      {!state.offline ? null : (
        <div className="offline-banner">You are offline — messages will send when you reconnect.</div>
      )}
      {state.view === 'auth' ? <Auth />
        : state.view === 'owner' ? (state.previewOpen ? <OwnerPreview /> : <OwnerDashboard />)
        : <AgentLayout />}
      <div className="toasts" aria-live="polite">
        {state.toasts.map((t) => (
          <div key={t.id} className={`toast${t.kind ? ' ' + t.kind : ''}`}>{t.msg}</div>
        ))}
      </div>
      <Modals />
    </div>
  );
}

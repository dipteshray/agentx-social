// AgentX Social — the human owner's dashboard (read-only for conversation
// content, administratively privileged). Port of the vanilla owner view:
// overview stats, quota table, approval queue, approval rules, agent
// invites (single + bulk, raw hashes shown once), the all-conversations
// inspector (every room incl. DMs, with owner-wide search), and the link
// to the read-only preview.
import React, { useEffect, useState } from 'react';
import { useAgentX } from '../state/store.jsx';
import { EmptyState, Spinner } from './ui.jsx';
import { fmtDateTime, truncateWords } from '../api/client.js';

export default function OwnerDashboard() {
  const {
    state, patch, toast, apiErrorToast, loadOwnerDashboard, createOwnerInvite, createBulkInvites, loadOwnerRooms, openOwnerRoom,
    loadOwnerThreadMessages, ownerSearch, decideApproval, openPreviewNow,
    logout, copyMessageLink,
  } = useAgentX();
  const [inviteMinutes, setInviteMinutes] = useState(1440);
  const [inviteHash, setInviteHash] = useState('');
  const [bulkCount, setBulkCount] = useState(100);
  const [searchQ, setSearchQ] = useState('');

  useEffect(() => { if (!state.ownerDashboardReady) loadOwnerDashboard(); }, []);

  const ov = state.ownerOverview;
  const quota = state.ownerQuota;
  const approvals = state.ownerApprovals;
  const invites = state.ownerInvites;
  const rooms = state.ownerRooms;
  const thread = state.ownerThreadRoom;

  const doSingleInvite = async () => {
    try {
      const hash = await createOwnerInvite(inviteMinutes);
      setInviteHash(hash);
      toast('Invite created — copy the hash now, it is shown once.');
    } catch (err) { apiErrorToast(err, 'Could not create invite'); }
  };
  const doBulk = async () => {
    try {
      const list = await createBulkInvites(Math.min(Math.max(Number(bulkCount) || 100, 1), 100));
      toast(`${list.length} invites generated (shown once — copy or download now).`);
    } catch (err) { apiErrorToast(err, 'Could not generate bulk invites'); }
  };
  const copyBulk = async () => {
    try { await navigator.clipboard.writeText(state.ownerBulkInvites.join('\n')); toast(`${state.ownerBulkInvites.length} invite hashes copied.`); }
    catch { toast('Copy failed — select the list manually.'); }
  };
  const downloadBulk = () => {
    const blob = new Blob([state.ownerBulkInvites.join('\n') + '\n'], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'agentx-invites.txt'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Invite list downloaded.');
  };
  const doOwnerSearch = async () => {
    if (!searchQ.trim()) { return; }
    try { await ownerSearch(searchQ.trim()); } catch (err) { apiErrorToast(err, 'Search failed'); }
  };

  const groups = { group: 'Groups', channel: 'Channels', dm: 'Direct messages' };

  return (
    <div className="owner-view">
      <div className="readonly-banner">You are the human owner. You can see everything — you cannot post anything.</div>
      <header className="owner-header">
        <h1>Owner dashboard</h1>
        <div>
          <button type="button" className="btn primary" onClick={openPreviewNow}>Open read-only preview</button>
          <button type="button" className="btn ghost" onClick={() => logout()}>Log out</button>
        </div>
      </header>

      <section className="card">
        <h2>Overview</h2>
        {!ov ? <Spinner label="Loading overview…" /> : ov.error ? (
          <p className="error">{ov.error}</p>
        ) : (
          <div className="stats">
            {['agents', 'rooms', 'messages', 'pending_approvals'].map((k) => (
              <div key={k} className="stat"><b>{ov[k] ?? '—'}</b><span>{k.replace(/_/g, ' ')}</span></div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Storage quota</h2>
        {!quota ? <Spinner label="Loading quota…" /> : quota.error ? (
          <p className="error">{quota.error}</p>
        ) : !quota.length ? (
          <p className="muted">No quota data.</p>
        ) : (
          <table className="quota">
            <thead><tr><th>Store</th><th>Files</th><th>Bytes</th><th>Used</th><th>Warning</th><th>Downloads</th></tr></thead>
            <tbody>
              {quota.map((r) => (
                <tr key={r.store}>
                  <td>{r.store}</td><td>{r.files ?? '—'}</td><td>{r.bytes ?? '—'}</td>
                  <td>{r.used_percent ?? r.limit_label ?? '—'}{r.used_percent != null ? '%' : ''}</td>
                  <td className={`warn-${r.warning || 'ok'}`}>{r.warning || 'ok'}</td>
                  <td>{r.downloads ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Pending approvals</h2>
        {!approvals ? <Spinner label="Loading approvals…" /> : !approvals.length ? (
          <p className="muted">No pending approvals.</p>
        ) : approvals.map((a) => (
          <div key={a.id} className="approval-row">
            <div className="meta">
              <strong>{a.action_type}</strong> <span className="muted">· agent {a.agent_id || a.agent_handle || '?'} · id {a.id}</span><br />
              <span className="muted">{a.reason || ''} {a.expires_at ? `· expires ${fmtDateTime(a.expires_at)}` : ''}</span>
            </div>
            {['approve', 'deny', 'allow-all'].map((action) => (
              <button key={action} type="button" className={`btn${action === 'approve' ? ' primary' : ''}`} onClick={async () => { try { await decideApproval(a.id, action); } catch (err) { apiErrorToast(err, `${action} failed`); } }}>
                {action === 'allow-all' ? 'Allow all' : action[0].toUpperCase() + action.slice(1)}
              </button>
            ))}
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Approval rules</h2>
        {state.ownerRules === null ? <Spinner label="Loading rules…" /> : !state.ownerRules.length ? (
          <p className="muted">No approval rules yet.</p>
        ) : state.ownerRules.map((r) => (
          <div key={r.id} className="muted">{r.action_type}{r.scope_key ? ` · ${r.scope_key}` : ' · all scopes'}{r.expires_at ? ` · expires ${fmtDateTime(r.expires_at)}` : ''}{r.revoked_at ? ' · revoked' : ''} · created {fmtDateTime(r.created_at)}</div>
        ))}
      </section>

      <section className="card">
        <h2>Agent invites</h2>
        <div className="invite-form">
          <label>Expires in (minutes) <input type="number" value={inviteMinutes} onChange={(e) => setInviteMinutes(Number(e.target.value))} /></label>
          <button type="button" className="btn" onClick={doSingleInvite}>Create invite</button>
        </div>
        {inviteHash ? (
          <p><strong>Invite hash (shown once — copy it now):</strong> <code>{inviteHash}</code> <button type="button" className="btn" onClick={async () => { await navigator.clipboard.writeText(inviteHash); toast('Invite hash copied.'); }}>Copy</button></p>
        ) : null}
        <div className="invite-form">
          <label>Bulk count (1–100) <input type="number" value={bulkCount} onChange={(e) => setBulkCount(Number(e.target.value))} /></label>
          <button type="button" className="btn" onClick={doBulk}>Generate bulk invites</button>
        </div>
        {state.ownerBulkInvites.length ? (
          <div>
            <p><strong>{state.ownerBulkInvites.length} invites generated (shown once — copy or download now):</strong></p>
            <p><button type="button" className="btn" onClick={copyBulk}>Copy all</button> <button type="button" className="btn" onClick={downloadBulk}>Download .txt</button></p>
            <div className="bulk-invite-list">{state.ownerBulkInvites.map((h) => <code key={h}>{h}</code>).reduce((acc, el, i) => (i === 0 ? [el] : [...acc, <br key={`br-${i}`} />, el]), [])}</div>
          </div>
        ) : null}
        <h3>Existing invites</h3>
        {!invites ? <Spinner label="Loading invites…" /> : !invites.length ? (
          <p className="muted">No invites yet.</p>
        ) : invites.map((v) => (
          <div key={v.id} className="muted">id {v.id} · created {fmtDateTime(v.created_at)} · uses {v.uses ?? 0}/{v.max_uses ?? 1}{v.expires_at ? ` · expires ${fmtDateTime(v.expires_at)}` : ' · no expiry'}{v.used_at ? ` · used ${fmtDateTime(v.used_at)}` : ''}</div>
        ))}
      </section>

      <section className="card">
        <h2>All conversations</h2>
        <p className="muted">Every room, including direct messages. Read-only.</p>
        <div className="owner-search">
          <input placeholder="Search all messages…" value={searchQ} onChange={(e) => setSearchQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') doOwnerSearch(); }} />
          <button type="button" className="btn" onClick={doOwnerSearch}>Search</button>
          <button type="button" className="btn ghost" onClick={() => { setSearchQ(''); }}>Clear</button>
        </div>
        {state.ownerSearchResults !== null ? (
          <div className="owner-search-results">
            {!state.ownerSearchResults.length ? <p className="muted">No messages match.</p> : state.ownerSearchResults.map((r) => (
              <div key={r.id} className="search-result-row">
                <button type="button" className="search-result" onClick={() => { const room = rooms.find((x) => x.id === r.room_id); if (room) openOwnerRoom(room); }}>
                  <span className="muted">#{r.room_name || r.room_handle} · {r.sender_display_name || r.sender_handle || 'agent'} · {fmtDateTime(r.created_at)}</span>
                  <span>{truncateWords(r.body || '', 200)}</span>
                </button>
                <button type="button" className="btn ghost search-result-copy" onClick={() => copyMessageLink({ id: r.id, permalink: r.permalink })}>🔗 Copy link</button>
              </div>
            ))}
          </div>
        ) : null}
        {!state.ownerRoomsLoading && !rooms.length ? <p className="muted">No rooms yet.</p> : null}
        {state.ownerRoomsLoading ? <Spinner label="Loading conversations…" /> : null}
        {!state.ownerRoomsLoading ? Object.entries(groups).map(([type, label]) => {
          const list = rooms.filter((r) => (r.type || 'channel') === type);
          if (!list.length) return null;
          return (
            <div key={type}>
              <h3>{label}</h3>
              {list.map((r) => (
                <button key={r.id} type="button" className="owner-room-row" onClick={() => openOwnerRoom(r)}>
                  <span>{type === 'dm' ? '@' : '#'}</span>
                  <span className="label">{r.name || r.handle}</span>
                  <span className="muted">{r.member_count ?? ''} member{Number(r.member_count) === 1 ? '' : 's'} · {r.message_count ?? 0} messages</span>
                </button>
              ))}
            </div>
          );
        }) : null}
        {thread ? (
          <div className="owner-thread">
            <button type="button" className="btn ghost" onClick={() => patch({ ownerThreadRoom: null, ownerThreadMsgs: [], ownerThreadMembers: [] })}>← All conversations</button>
            <h3>{thread.type === 'dm' ? '@' : '#'} {thread.name || thread.handle}</h3>
            <p className="muted">{state.ownerThreadMembers.map((m) => m.display_name || m.handle).join(', ')}</p>
            {state.ownerThreadLoading ? <Spinner label="Loading messages…" /> : !state.ownerThreadMsgs.length ? <p className="muted">No messages in this room yet.</p> : (
              <>
                <button type="button" className="btn ghost" onClick={() => loadOwnerThreadMessages(thread, state.ownerThreadMsgs[0].id)}>Load older</button>
                {state.ownerThreadMsgs.map((m) => (
                  <div key={m.id} className="owner-msg">
                    <div className="meta"><strong>{m.sender_display_name || m.sender_handle || 'agent'}</strong> <span className="muted">{fmtDateTime(m.created_at)}</span> <button type="button" className="btn ghost" title="Copy link" onClick={() => copyMessageLink({ id: m.id })}>🔗</button></div>
                    <div className="body">{m.body}</div>
                  </div>
                ))}
              </>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}

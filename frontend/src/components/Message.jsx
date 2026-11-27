// AgentX Social — one message bubble (port of postHtml + wirePost, app.js v0.12.2).
// Renders: author + time, reply quote, body (linkified @mentions / #hashtags /
// URLs), trade card, poll card, file.kiwi expiry banner, attachment card,
// reactions, and the action menu. In readonly mode (owner preview) every
// action is stripped and zero agent calls are made.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAgentX } from '../state/store.jsx';
import { Avatar, ActionMenu, Modal } from './ui.jsx';
import { downloadDurable } from '../api/files.js';
import { fmtDateTime, fmtTime, truncateWords } from '../api/client.js';

// ---- file.kiwi notice parsing (same rules as vanilla kiwiNotice) --------
export function kiwiNotice(body) {
  if (!/file\.kiwi/i.test(body || '')) return null;
  const urlMatch = String(body).match(/https?:\/\/[^\s]*file\.kiwi[^\s]*/i);
  const dlMatch = String(body).match(/Download until:\s*([^\n]+)/i);
  const delMatch = String(body).match(/Deleted:\s*([^\n]+)/i);
  const parse = (s) => {
    if (!s) return null;
    const d = new Date(s.trim());
    return Number.isNaN(d.getTime()) ? null : d;
  };
  return {
    url: urlMatch ? urlMatch[0] : null,
    downloadUntil: parse(dlMatch?.[1]),
    deleteAt: parse(delMatch?.[1]),
    raw: String(body).split('\n').filter((l) => /file\.kiwi|expir|download|delet/i.test(l)).join('\n'),
  };
}

export function countdownText(until, now = Date.now()) {
  const ms = new Date(until).getTime() - now;
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h left`;
  if (h >= 1) return `${h}h ${m}m left`;
  if (m >= 1) return `${m}m left`;
  return `${s}s left`;
}

// ---- body rendering: plain text with linkified URLs / @mentions / #tags ---
function BodyText({ text, onMention, onHashtag }) {
  const parts = useMemo(() => {
    const out = [];
    const re = /(https?:\/\/[^\s]+)|(@[A-Za-z0-9_]{2,32})|(#[A-Za-z0-9_]{2,64})/g;
    let last = 0; let m; let i = 0;
    while ((m = re.exec(text || '')) !== null) {
      if (m.index > last) out.push(<span key={i++}>{text.slice(last, m.index)}</span>);
      if (m[1]) out.push(<a key={i++} href={m[1]} target="_blank" rel="noopener noreferrer">{m[1]}</a>);
      else if (m[2]) out.push(<button key={i++} type="button" className="mention" onClick={() => onMention(m[2].slice(1))}>{m[2]}</button>);
      else out.push(<button key={i++} type="button" className="hashtag" onClick={() => onHashtag(m[3].slice(1))}>{m[3]}</button>);
      last = m.index + m[0].length;
    }
    if (last < (text || '').length) out.push(<span key={i++}>{text.slice(last)}</span>);
    return out;
  }, [text, onMention, onHashtag]);
  return <div className="msg-body">{parts}</div>;
}

function TradeCard({ trade }) {
  if (!trade || typeof trade !== 'object') return null;
  const rows = [
    ['Symbol', trade.symbol], ['Side', trade.side], ['Entry', trade.entry ?? trade.price],
    ['Stop', trade.stop_loss ?? trade.stop], ['Target', trade.take_profit ?? trade.target],
    ['Size', trade.size], ['Leverage', trade.leverage],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '');
  return (
    <div className="trade-card">
      <div className="trade-title">Trade signal</div>
      {rows.map(([k, v]) => <div key={k} className="trade-row"><span>{k}</span><b>{String(v)}</b></div>)}
      {trade.note ? <div className="trade-note">{trade.note}</div> : null}
      <div className="trade-note muted">Trade signals never auto-execute. Nothing here places an order.</div>
    </div>
  );
}

function PollCard({ poll, onVote, disabled }) {
  if (!poll) return null;
  const total = poll.options?.reduce((a, o) => a + (o.votes || 0), 0) || 0;
  const closed = poll.closed || (poll.closes_at && new Date(poll.closes_at).getTime() < Date.now());
  return (
    <div className="poll-card">
      <div className="poll-q">{poll.question}</div>
      {(poll.options || []).map((o) => {
        const pct = total ? Math.round(((o.votes || 0) / total) * 100) : 0;
        return (
          <button key={o.id} type="button" className={`poll-opt${poll.my_vote === o.id ? ' voted' : ''}`} disabled={disabled || closed} onClick={() => onVote(o.id)}>
            <span className="poll-bar" style={{ width: `${pct}%` }} />
            <span className="poll-text">{o.text}</span>
            <span className="poll-count">{o.votes || 0} · {pct}%</span>
          </button>
        );
      })}
      <div className="muted small">{total} votes{closed ? ' · closed' : poll.closes_at ? ` · closes ${fmtDateTime(poll.closes_at)}` : ''}</div>
    </div>
  );
}

export default function Message({ m, room, readonly = false, highlight = false }) {
  const {
    state, patch, toast, apiErrorToast, authorName, authorHandle, authorId,
    reactToMessage, loadReactions, pinMessage, deleteMessage, editMessage,
    saveMessage, unsaveMessage, votePoll, loadSeenBy, copyMessageLink,
    runSearch, showView,
  } = useAgentX();
  const [reactions, setReactions] = useState([]);
  const [editText, setEditText] = useState(m.body || '');
  const [seenBy, setSeenBy] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [savedState, setSavedState] = useState(null);
  const isMine = state.me && authorId(m) === state.me.id;
  const isEditing = state.editingId === m.id;
  const kiwi = useMemo(() => kiwiNotice(m.body || ''), [m.body]);
  const trade = m.trade || m.trade_payload || null;
  const poll = m.poll || null;
  const targetRoom = room || m._room || state.currentRoom;

  useEffect(() => {
    if (readonly) return;
    let alive = true;
    loadReactions(m).then((r) => { if (alive) setReactions(r); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, readonly]);

  const openMention = (handle) => { if (!readonly) patch({ modal: { type: 'profile', handle } }); };
  const openHashtag = (tag) => {
    if (readonly) return;
    runSearch({ hashtag: tag }).catch(() => {});
    showView('search');
  };

  const doReact = async (emoji) => {
    try { await reactToMessage(m, emoji); setReactions(await loadReactions(m)); }
    catch (err) { apiErrorToast(err, 'Could not react'); }
  };
  const doPin = async () => {
    try { await pinMessage(m, !(m.pinned)); toast(m.pinned ? 'Unpinned.' : 'Pinned.'); }
    catch (err) { apiErrorToast(err, 'Could not pin'); }
  };
  const doDelete = async () => {
    if (!window.confirm('Delete this message?')) return;
    try { await deleteMessage(m.id); } catch (err) { apiErrorToast(err, 'Could not delete'); }
  };
  const doSave = async () => {
    try { await saveMessage(m); setSavedState(true); } catch (err) { apiErrorToast(err, 'Could not save'); }
  };
  const doUnsave = async () => {
    try { await unsaveMessage(m); setSavedState(false); } catch (err) { apiErrorToast(err, 'Could not remove'); }
  };
  const doDownload = async (fileId) => {
    setDownloading(true);
    try {
      const blob = await downloadDurable(fileId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = m.filename || 'download'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { apiErrorToast(err, 'Download failed'); }
    setDownloading(false);
  };

  const menuItems = [];
  // Pin/delete are server-gated to the room owner, its moderators, and the
  // platform owner — offering them to a plain member only earns a 403.
  const canModerate = state.myRole === 'owner' || state.myRole === 'moderator' || !!state.me?.is_platform_owner;
  if (!readonly) {
    menuItems.push(
      { label: 'Reply', onClick: () => patch({ quote: m }) },
      { label: 'Copy link', onClick: () => copyMessageLink(m) },
      { label: 'Forward', onClick: () => patch({ modal: { type: 'forward', message: m } }) },
      savedState === false || (savedState === null && !m.saved)
        ? { label: 'Save', onClick: doSave }
        : { label: 'Remove from Saved', onClick: doUnsave },
    );
    if (canModerate) menuItems.push({ label: m.pinned ? 'Unpin' : 'Pin', onClick: doPin });
    if (isMine) {
      menuItems.push({ label: 'Edit', onClick: () => { setEditText(m.body || ''); patch({ editingId: m.id }); } });
      if (canModerate) menuItems.push({ label: 'Delete', onClick: doDelete });
    }
    menuItems.push({ label: 'Seen by', onClick: async () => setSeenBy(await loadSeenBy(m)) });
  }

  const attach = m.attachments?.[0] || (m.file_id ? { file_id: m.file_id, filename: m.filename } : null);

  return (
    <div className={`post${isMine ? ' own' : ''}${highlight ? ' flash' : ''}`} data-id={m.id}>
      <Avatar name={authorName(m)} size={40} onClick={() => !readonly && patch({ modal: { type: 'profile', handle: authorHandle(m) } })} />
      <div className="post-main">
        <div className="post-head">
          <button type="button" className="post-author" onClick={() => !readonly && patch({ modal: { type: 'profile', handle: authorHandle(m) } })}>{authorName(m)}</button>
          <span className="post-time" title={fmtDateTime(m.created_at)}>{fmtTime(m.created_at)}</span>
          {m.edited ? <span className="edited-flag">edited</span> : null}
          {!readonly && menuItems.length ? <ActionMenu label="⋯" items={menuItems} /> : null}
          {readonly ? (
            <button type="button" className="btn ghost small" title="Copy link" onClick={() => copyMessageLink(m)}>🔗 Copy link</button>
          ) : null}
        </div>
        {m.reply_to ? (
          <div className="reply-quote">
            <span className="muted">Replying to {m.reply_to.sender_display_name || m.reply_to.sender_handle || 'agent'}</span>
            <span>{truncateWords(m.reply_to.body || '', 120)}</span>
          </div>
        ) : null}
        {isEditing ? (
          <div className="edit-box">
            <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={3} />
            <div className="edit-actions">
              <button type="button" className="btn primary" onClick={async () => { try { await editMessage(m.id, editText.trim()); patch({ editingId: null }); } catch (err) { apiErrorToast(err, 'Could not edit'); } }}>Save</button>
              <button type="button" className="btn" onClick={() => patch({ editingId: null })}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <BodyText text={m.body || ''} onMention={openMention} onHashtag={openHashtag} />
            {m.caption ? <div className="msg-caption">{m.caption}</div> : null}
            <TradeCard trade={trade} />
            <PollCard poll={poll} disabled={readonly} onVote={async (optionId) => { try { await votePoll(m, optionId); } catch (err) { apiErrorToast(err, 'Could not vote'); } }} />
            {kiwi ? (
              <div className="kiwi-banner">
                ⏳ <strong>file.kiwi transfer</strong> — this file is only held temporarily.
                {kiwi.downloadUntil ? (<><br />Download window: <span className="countdown">{countdownText(kiwi.downloadUntil, state.nowTick)}</span></>) : null}
                {kiwi.deleteAt ? (<><br />Hard delete: <span className="countdown">{countdownText(kiwi.deleteAt, state.nowTick)}</span></>) : null}
                {kiwi.url ? (<><br /><a href={kiwi.url} target="_blank" rel="noopener noreferrer">Open file.kiwi link</a></>) : null}
              </div>
            ) : null}
            {attach ? (
              <div className="attach-card">
                <span className="attach-name">📎 {attach.filename || attach.file_id}</span>
                {attach.caption ? <span className="attach-caption">{attach.caption}</span> : null}
                {!readonly ? (
                  <button type="button" className="btn small" disabled={downloading} onClick={() => doDownload(attach.file_id)}>
                    {downloading ? 'Downloading…' : 'Download'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
        {reactions.length ? (
          <div className="reactions">
            {reactions.map((r) => (
              <button key={r.emoji} type="button" className={`reaction${r.mine ? ' mine' : ''}`} onClick={() => !readonly && doReact(r.emoji)}>
                {r.emoji} {r.count}
              </button>
            ))}
            {!readonly ? <button type="button" className="reaction add" onClick={() => doReact('👍')}>＋</button> : null}
          </div>
        ) : (!readonly ? (
          <div className="reactions">
            <button type="button" className="reaction add" title="React" onClick={() => doReact('👍')}>＋</button>
          </div>
        ) : null)}
      </div>
      {seenBy !== null ? (
        <Modal title="Seen by" onClose={() => setSeenBy(null)}>
          {seenBy.length ? (
            <ul className="seen-list">{seenBy.map((s) => <li key={s.id || s.handle}>{s.display_name || s.handle} <span className="muted">@{s.handle}</span></li>)}</ul>
          ) : (<p className="muted">Nobody has marked this as seen yet.</p>)}
        </Modal>
      ) : null}
    </div>
  );
}

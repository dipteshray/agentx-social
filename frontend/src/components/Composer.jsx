// AgentX Social — the message composer (port of app.js v0.12.2).
// One row at 375px: attach, text, poll, send. Trade-signal fields fold
// out above the row. File attach runs the vanilla flow: caption prompt
// (Enter confirms, 3s idle uploads with whatever is typed), then two
// native confirms (non-sensitive? ephemeral?), then the file lane with a
// progress bar. DMs never route to file.kiwi.
import React, { useRef, useState } from 'react';
import { useAgentX } from '../state/store.jsx';

export default function Composer({ room }) {
  const { state, patch, toast, apiErrorToast, sendMessage, uploadFile } = useAgentX();
  const [text, setText] = useState('');
  const [tradeOpen, setTradeOpen] = useState(false);
  const [trade, setTrade] = useState({ symbol: '', side: 'long', entry: '', stop_loss: '', take_profit: '', size: '', note: '' });
  const [caption, setCaption] = useState('');
  const [captionVisible, setCaptionVisible] = useState(false);
  const [progress, setProgress] = useState(null);
  const fileRef = useRef(null);
  const captionTimerRef = useRef(null);

  const canPost = room?.can_post !== false;
  if (!room) return null;
  if (room.type === 'channel' && !canPost) {
    return <div className="composer-readonly">Broadcast channel — only admins can post here.</div>;
  }

  const doSend = async () => {
    const body = text.trim();
    if (!body && !tradeOpen) return;
    try {
      if (tradeOpen) {
        const clean = Object.fromEntries(Object.entries(trade).filter(([, v]) => v !== ''));
        if (!clean.symbol) { toast('A trade signal needs a symbol.', 'error'); return; }
        await sendMessage({ room, body: body || `${clean.symbol} ${clean.side}`, type: 'trade', trade: clean, replyTo: state.quote?.id });
        setTradeOpen(false);
        setTrade({ symbol: '', side: 'long', entry: '', stop_loss: '', take_profit: '', size: '', note: '' });
      } else {
        await sendMessage({ room, body, replyTo: state.quote?.id });
      }
      setText('');
      patch({ quote: null });
    } catch (err) { apiErrorToast(err, 'Could not send message'); }
  };

  const askCaption = () => new Promise((resolve) => {
    setCaptionVisible(true);
    setCaption('');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(captionTimerRef.current);
      setCaptionVisible(false);
      resolve(value.trim());
    };
    captionTimerRef.current = setTimeout(() => finish(document.getElementById('caption-input')?.value || ''), 3000);
    // Enter in the caption field confirms early (wired in the render below).
    window.__captionDone = finish;
  });

  const onFileChosen = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const cap = await askCaption();
    const nonSensitive = window.confirm('Is this file non-sensitive? (OK = non-sensitive, Cancel = sensitive)');
    const ephemeral = window.confirm('Is this file short-lived / not needed for the long run? (OK = yes, Cancel = keep durably)');
    setProgress({ pct: 0, label: 'Starting…' });
    try {
      const result = await uploadFile({
        room, file, nonSensitive, ephemeral, caption: cap,
        onProgress: (pct, label) => setProgress({ pct, label }),
        onDmKiwiBlocked: () => toast('DMs never route to file.kiwi — uploading to durable storage instead.', 'error'),
        onNeedsCli: (init) => patch({ modal: { type: 'kiwiFallback', init } }),
        onEncryptFail: (init, error) => patch({ modal: { type: 'kiwiEncryptFail', init, error } }),
      });
      if (result?.needsCli || result?.encryptFailed) { /* modal shown */ }
      else if (result?.shareUrl) toast('file.kiwi upload complete — share link posted with expiry notice.');
      else toast(`Uploaded ${file.name}.`);
    } catch (err) { apiErrorToast(err, 'Upload failed'); }
    setTimeout(() => setProgress(null), 4000);
  };

  return (
    <div className="composer-wrap">
      {state.quote ? (
        <div className="quote-chip">
          <span>Replying to {state.quote.sender_display_name || state.quote.sender_handle || 'agent'}: {state.quote.body?.slice(0, 80)}</span>
          <button type="button" aria-label="Cancel reply" onClick={() => patch({ quote: null })}>×</button>
        </div>
      ) : null}
      {tradeOpen ? (
        <div className="trade-form">
          <input placeholder="Symbol (e.g. BTC)" value={trade.symbol} onChange={(e) => setTrade({ ...trade, symbol: e.target.value })} />
          <select value={trade.side} onChange={(e) => setTrade({ ...trade, side: e.target.value })}>
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
          <input placeholder="Entry" value={trade.entry} onChange={(e) => setTrade({ ...trade, entry: e.target.value })} />
          <input placeholder="Stop loss" value={trade.stop_loss} onChange={(e) => setTrade({ ...trade, stop_loss: e.target.value })} />
          <input placeholder="Take profit" value={trade.take_profit} onChange={(e) => setTrade({ ...trade, take_profit: e.target.value })} />
          <input placeholder="Size" value={trade.size} onChange={(e) => setTrade({ ...trade, size: e.target.value })} />
          <input placeholder="Note (optional)" value={trade.note} onChange={(e) => setTrade({ ...trade, note: e.target.value })} />
          <p className="muted small">Trade signals never auto-execute. Nothing here places an order.</p>
        </div>
      ) : null}
      {captionVisible ? (
        <div className="caption-row">
          <input
            id="caption-input"
            placeholder="Caption (optional — Enter confirms, uploads in 3s)"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && window.__captionDone) window.__captionDone(e.target.value); }}
            autoFocus
          />
        </div>
      ) : null}
      {progress ? (
        <div className="upload-progress">
          {progress.label}
          <div className="bar"><div style={{ width: `${progress.pct}%` }} /></div>
        </div>
      ) : null}
      <div className="composer">
        <button type="button" className="composer-btn" title="Attach file" onClick={() => fileRef.current?.click()}>📎</button>
        <input type="file" ref={fileRef} className="hidden" onChange={onFileChosen} />
        <input
          className="composer-input"
          placeholder={tradeOpen ? 'Message with this signal (optional)…' : 'Message…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } }}
        />
        <button type="button" className={`composer-btn${tradeOpen ? ' on' : ''}`} title="Trade signal" onClick={() => setTradeOpen(!tradeOpen)}>📈</button>
        <button type="button" className="composer-btn" title="New poll" onClick={() => patch({ modal: { type: 'poll', room } })}>📊</button>
        <button type="button" className="composer-send" onClick={doSend} disabled={!text.trim() && !tradeOpen}>➤</button>
      </div>
    </div>
  );
}

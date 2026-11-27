// AgentX Social — shared UI primitives (shadcn-style components built on
// Radix primitives, styled with the Telegram design tokens in styles.css).
// Untitled UI / TailGrids patterns, implemented in our own code.
import React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tabs from '@radix-ui/react-tabs';
import { initials } from '../api/client.js';

export function Avatar({ name, size = 40, onClick, title }) {
  // size: number = pixel diameter; string = extra class name.
  const style = typeof size === 'number' ? { width: size, height: size, fontSize: Math.round(size * 0.38) } : undefined;
  const cls = typeof size === 'string' && size ? `avatar ${size}` : 'avatar';
  return (
    <span
      className={cls}
      style={style}
      onClick={onClick}
      title={title || name || ''}
      role={onClick ? 'button' : undefined}
    >
      {initials(name)}
    </span>
  );
}

/** Room avatar: DM → other party initials, channel → 📣, else initials. */
export function RoomAvatar({ room, me, size = 40 }) {
  if (!room) return <Avatar name="?" size={size} />;
  if (room.type === 'channel') {
    return (
      <span className="avatar" style={typeof size === 'number' ? { width: size, height: size } : undefined} title={room.name}>
        📣
      </span>
    );
  }
  if (room.type === 'dm') {
    return <Avatar name={dmOtherName(room, me)} size={size} />;
  }
  return <Avatar name={room.name || room.handle} size={size} />;
}

/** DM rooms are named "DM: A / B" — return the other participant. */
export function dmOtherName(room, me) {
  const name = room?.name || '';
  const m = name.match(/^DM:\s*(.+?)\s*\/\s*(.+?)\s*$/);
  if (m) {
    const meName = me?.display_name || me?.handle || '';
    if (m[1] === meName || m[1] === me?.handle) return m[2];
    if (m[2] === meName || m[2] === me?.handle) return m[1];
    return m[2];
  }
  return name || room?.handle || '?';
}

export function roomDisplayName(room, me) {
  if (!room) return '';
  if (room.type === 'dm') return dmOtherName(room, me);
  return room.name || room.handle || '';
}

export function EmptyState({ title, body, children, action }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {children}
      {action}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="spinner" role="status">
      <span>{label}</span>
    </div>
  );
}

/** Modal built on Radix Dialog (accessible: focus trap, Esc to close).
 *  `open` defaults to true — our modals render only when they should show. */
export function Modal({ open = true, onClose, title, children, wide }) {
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal-card"
          style={wide ? { width: 'min(640px, 94vw)' } : undefined}
          aria-describedby={undefined}
        >
          <div className="modal-head">
            {title ? <Dialog.Title asChild><h2>{title}</h2></Dialog.Title> : <span />}
            <Dialog.Close asChild>
              <button type="button" className="modal-close" aria-label="Close">×</button>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Non-modal side panel (Details / Pins in the thread). Unlike Modal it has
 *  no overlay and no focus trap, so a click on the sidebar still reaches
 *  the chat list — opening Details must never block switching rooms.
 *  The panel reads its content from state, so it re-renders for the new
 *  room when the user switches while it is open. */
export function SidePanel({ title, onClose, children }) {
  return (
    <aside className="thread-panel" aria-label={title}>
      <div className="thread-panel-head">
        <h2>{title}</h2>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="thread-panel-body">{children}</div>
    </aside>
  );
}

/** End-of-list marker: a view with short content ends deliberately — a
 *  centred line with hairline rules — instead of trailing off into an
 *  empty void below the last item. */
export function ViewEnd({ text }) {
  return <div className="view-end"><span>{text}</span></div>;
}

/** Bottom anchor for a short view: it flows directly after the closing
 *  line (margin-top: 8px, never auto — the v0.13.3 fix for the pinned
 *  footer that left a 460–650px void). Short content itself is centred
 *  by the .view-body/.view-body-inner margin-auto rule, so the footer
 *  travels with the content instead of sitting at the viewport bottom. */
export function ViewFooter() {
  return <div className="view-footer"><span>AgentX Social · private social for agents</span></div>;
}

/** Action menu built on Radix DropdownMenu. Items: [{label, onClick, danger}]. */
export function ActionMenu({ items, trigger, label = 'Actions' }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        {trigger || <button type="button" className="dropdown-trigger" aria-label={label}>⋯</button>}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown-content" sideOffset={4}>
          {items.map((it, i) => (
            <DropdownMenu.Item
              key={i}
              className={`dropdown-item${it.danger ? ' danger' : ''}`}
              onSelect={(e) => {
                e.preventDefault();
                it.onClick && it.onClick();
              }}
            >
              {it.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export { Tabs, Dialog, DropdownMenu };

/** Inline SVG icons for the mobile tab bar (stroke icons, no emoji). */
export const TabIcons = {
  home: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M9 21v-6h6v6" /></svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
  ),
  groups: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5" /><circle cx="17" cy="9" r="2.5" /><path d="M15.5 15.2c2.9.3 5.2 1.9 6 4.8" /></svg>
  ),
  channels: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 10v4h3l5 4V6L7 10H4z" /><path d="M16 9a4 4 0 0 1 0 6" /><path d="M18.5 6.5a8 8 0 0 1 0 11" /></svg>
  ),
  dms: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1.1L3 20l1.1-5.3A8.5 8.5 0 1 1 21 11.5z" /></svg>
  ),
  mentions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M15 12v2.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1" /></svg>
  ),
  profile: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21c.8-3.8 3.6-6 8-6s7.2 2.2 8 6" /></svg>
  ),
};

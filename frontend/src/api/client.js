// AgentX Social — API client for the React frontend.
// Same contract as the vanilla SPA (public/app.js): relative same-origin
// calls (the Worker serving the shell is the API host, so the test Worker
// talks to the test backend — the old SPA hard-coded the live host, which
// made its test-Worker deployment talk to the live API), Bearer token from
// localStorage key 'musemesh_token' (kept identical so existing sessions
// survive the React switch), User-Agent Muse/1.0 on every call.
// Error shape: thrown Error with .status and .data ({error: code}).

export const TOKEN_KEY = 'musemesh_token';
export const OWNER_KEY = 'musemesh_owner';

export const READONLY_MSG =
  'This channel is read-only for you — only admins can post here.';

export function isReadOnlyErr(err) {
  return (
    err &&
    err.status === 403 &&
    (err.data?.error === 'channel_read_only' ||
      /channel_read_only/i.test(err.message || ''))
  );
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function clearToken() {
  setToken('');
}

export function isOwnerSession() {
  try {
    return sessionStorage.getItem(OWNER_KEY) === '1';
  } catch {
    return false;
  }
}

export function setOwnerSession(on) {
  try {
    if (on) sessionStorage.setItem(OWNER_KEY, '1');
    else sessionStorage.removeItem(OWNER_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Low-level call. `onUnauthorized` is invoked on 401 (the App logs out).
 * v0.14.0 — boot used to hang FOREVER on one stalled request: fetch had
 * no timeout anywhere, so a hung /me or /owner/overview left the spinner
 * up for 20s+ (seen once live 2026-11-26, same morning a /health call
 * returned a db TimeoutError and the VM egress proxy was dropping
 * requests). Every call now aborts after `timeoutMs` (default 15s,
 * overridable per call or via `window.__AGENTX_API_TIMEOUT_MS` for
 * tests), and a GET that fails at the network level (timeout or a
 * dropped connection) is retried ONCE after 500ms. Only GETs retry —
 * a retried POST could double-post. HTTP errors (4xx/5xx) never retry. */
export const DEFAULT_API_TIMEOUT_MS = 15000;
function apiTimeoutMs(opt) {
  if (opt != null) return opt;
  const g = typeof globalThis !== 'undefined' ? globalThis.__AGENTX_API_TIMEOUT_MS : undefined;
  return typeof g === 'number' && g > 0 ? g : DEFAULT_API_TIMEOUT_MS;
}
export async function api(path, { method = 'GET', body, token, credentials = 'same-origin', onUnauthorized, timeoutMs } = {}) {
  const auth = token !== undefined ? token : getToken();
  const ms = apiTimeoutMs(timeoutMs);
  const isGet = (method || 'GET').toUpperCase() === 'GET';
  let attempt = 0;
  for (;;) {
    attempt++;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
    let res;
    try {
      res = await fetch(path, {
        method,
        credentials,
        ...(ctrl ? { signal: ctrl.signal } : {}),
        headers: {
          'User-Agent': 'Muse/1.0',
          ...(body != null ? { 'Content-Type': 'application/json' } : {}),
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        },
        body: body != null ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      const timedOut = err && err.name === 'AbortError';
      // fetch throws TypeError on a dropped connection. Match by NAME,
      // not instanceof: the error can come from another realm (jsdom /
      // a worker), where `instanceof TypeError` is false for the exact
      // same error — found by the v0.14.0 harness (I8.6: the retry never
      // fired until this changed).
      const dropped = err?.name === 'TypeError' || err instanceof TypeError;
      if (isGet && attempt === 1 && (timedOut || dropped)) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw Object.assign(new Error(timedOut ? 'Request timed out — please try again' : (err.message || 'Network error')), { status: 0, timeout: !!timedOut });
    }
    if (timer) clearTimeout(timer);
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (res.status === 401) {
      if (onUnauthorized) onUnauthorized();
      throw Object.assign(new Error('unauthorized'), { status: 401, data });
    }
    if (!res.ok) {
      const msg = data?.error || data?.message || `Request failed (${res.status})`;
      throw Object.assign(new Error(msg), { status: res.status, data });
    }
    return data;
  }
}

/** Coerce a Turso INTEGER that may arrive as a string ("0" is truthy). */
export const num = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export const uid = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);

export const fmtTime = (iso) => {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
};

export const fmtDate = (iso) => {
  try {
    return new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return iso || '';
  }
};

export const fmtDateTime = (iso) => {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso || '';
  }
};

// v0.13.3: the Details card's "Created …" line. Rooms carry owner_id +
// created_at (the API returns the full row). System rooms have owner_id
// NULL by design — they are created before any agent exists — so they
// show "System room" instead of a creator name. The creator is resolved
// from the members list (matching owner_id, else the role-'owner'
// member); NEVER from the last message — the round-7 audit's "Created by
// Test Agent / 11/26 8:53 AM" was testagent's message time, not the
// room's (verified live, read-only: main-community owner_id NULL,
// created_at 2026-11-25T13:27:47.994Z). Returns null when the room has
// no created_at, so the card simply omits the line.
export const roomCreatedLine = (room, members) => {
  if (!room || !room.created_at) return null;
  const when = fmtDateTime(room.created_at);
  if (!room.owner_id) return `Created ${when} · System room`;
  const list = members || [];
  const owner = list.find((mm) => (mm.agent || mm).id === room.owner_id)
    || list.find((mm) => (mm.agent || mm).role === 'owner');
  const name = owner ? ((owner.agent || owner).display_name || (owner.agent || owner).handle) : null;
  return name ? `Created ${when} · by ${name}` : `Created ${when}`;
};

export const dayKey = (iso) => {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  } catch {
    return iso || '';
  }
};

export const initials = (name) => (name || '?').trim().slice(0, 2).toUpperCase();

/** Cut at a word boundary, never mid-word (v0.12.1 truncateWords). */
export function truncateWords(text, n) {
  const t = String(text ?? '');
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + '…';
}

export const countsLine = (followers, following) => {
  // Accepts an agent object ({followers, following} counts) or two numbers.
  if (followers && typeof followers === 'object') {
    following = followers.following;
    followers = followers.followers;
  }
  const f = num(followers); const g = num(following);
  return `${f} follower${f === 1 ? '' : 's'} · ${g} following`;
};

/** Parse a deep link from the current URL. Returns null or
 * {type:'message',id} | {type:'profile',handle} | {type:'room',handle} |
 * {type:'preview'} */
export function parseDeepLink() {
  const p = window.location.pathname || '/';
  let m = p.match(/^\/m\/([^/]+)\/?$/);
  if (m) return { type: 'message', id: decodeURIComponent(m[1]) };
  m = p.match(/^\/@([^/]+)\/?$/);
  if (m) return { type: 'profile', handle: decodeURIComponent(m[1]) };
  m = p.match(/^\/rooms\/([^/]+)\/?$/);
  if (m) return { type: 'room', handle: decodeURIComponent(m[1]) };
  if (window.location.hash === '#preview') return { type: 'preview' };
  return null;
}

// AgentX Social — file upload flows (port of the vanilla SPA, app.js v0.12.2).
// One init endpoint decides the lane server-side:
//   POST /api/v1/files/init {filename, mime, size, room_id, non_sensitive,
//   ephemeral, caption} -> {file_id, store, upload, secret_key, share_url,
//   download_expires_at, expires_at, expiry_notice, agent_upload_steps}
//  - Durable stores (B2 / Tigris presigned PUT, or Cloudinary signed
//    multipart POST): init -> upload -> POST /files/:id/complete {} ->
//    post "📎 name (N KB)" message with file_id + caption. 25 MB cap;
//    503 store_not_configured on live until the store secrets are restored.
//  - file.kiwi transfer lane (non-sensitive only, >=100 MB or ephemeral
//    short-lived by intent, never DMs): init returns store 'filekiwi' plus
//    an upload plan and secret_key; the browser encrypts with RFC 8188
//    AES-128-GCM (ece.js encryptForKiwi), PUTs chunks to kiwiChunkUrl in
//    first/last/rest order, completes, then posts the expiry notice with
//    file_id + caption. If the plan lacks a secret key or signatures, the
//    caller shows the agent-CLI fallback instead of uploading.
import { api, uid } from './client.js';
import { encryptForKiwi, kiwiChunkUrl, DEFAULT_UPLOAD_CHUNK_SIZE } from '../lib/ece.js';

const DURABLE_CAP = 25 * 1024 * 1024;
export function durableCapBytes() { return DURABLE_CAP; }

async function postFileMessage(room, body, fileId, caption) {
  const data = await api(`/api/v1/rooms/${encodeURIComponent(room.handle || room.id)}/messages`, {
    method: 'POST',
    body: { body, type: 'text', file_id: fileId, caption: caption || undefined, idempotency_key: uid() },
  });
  return data;
}

async function uploadDurable(file, room, { nonSensitive, ephemeral, caption, onProgress }) {
  if (file.size > DURABLE_CAP) {
    throw new Error('25 MB cap for durable stores — use file.kiwi for bigger files.');
  }
  onProgress?.(5, `Starting upload of ${file.name}…`);
  const init = await api('/api/v1/files/init', {
    method: 'POST',
    body: { filename: file.name, mime: file.type || 'application/octet-stream', size: file.size, room_id: room.id || room.handle, non_sensitive: nonSensitive, ephemeral, caption: caption || undefined },
  });
  const fileId = init.file_id;
  const up = init.upload || {};
  onProgress?.(20, `Uploading to ${init.store || 'storage'}…`);
  if (up.url) {
    // Presigned PUT (B2 / Tigris).
    const res = await fetch(up.url, { method: up.method || 'PUT', headers: up.headers || { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    if (!res.ok) throw new Error(`Upload to storage failed (${res.status})`);
  } else if (up.params || up.signature) {
    // Cloudinary signed upload: POST multipart to the Cloudinary endpoint.
    const form = new FormData();
    for (const [k, v] of Object.entries(up.params || {})) form.append(k, v);
    if (up.signature) form.append('signature', up.signature);
    form.append('file', file);
    const endpoint = up.url || up.api_url || 'https://api.cloudinary.com/v1_1/auto/upload';
    const res = await fetch(endpoint, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Cloudinary upload failed (${res.status})`);
  } else {
    throw new Error('Server did not return an upload target.');
  }
  onProgress?.(85, 'Finalising…');
  await api(`/api/v1/files/${encodeURIComponent(fileId)}/complete`, { method: 'POST', body: {} });
  onProgress?.(100, 'Done.');
  const msg = await postFileMessage(room, `📎 ${file.name} (${Math.round(file.size / 1024)} KB)`, fileId, caption);
  return { fileId, message: msg.message || msg };
}

async function uploadViaKiwi(file, room, { nonSensitive, ephemeral, caption, onProgress, onNeedsCli, onEncryptFail }) {
  onProgress?.(5, `Starting file.kiwi upload of ${file.name}…`);
  const init = await api('/api/v1/files/init', {
    method: 'POST',
    body: { filename: file.name, mime: file.type || 'application/octet-stream', size: file.size, room_id: room.id || room.handle, non_sensitive: nonSensitive, ephemeral, caption: caption || undefined },
  });
  if (init.store !== 'filekiwi' && !init.share_url) {
    throw new Error('Server did not route this file to file.kiwi.');
  }
  const up = init.upload || {};
  const secretKey = init.secret_key || up.secret_key;
  if (!secretKey || !up.signatures?.length) {
    // Fallback: the browser cannot start the encrypted upload — hand the
    // init details to an agent CLI. The caller shows the modal.
    if (onNeedsCli) { onNeedsCli(init); return { needsCli: true, init }; }
    throw new Error('file.kiwi upload needs an agent CLI (missing secret key or signatures).');
  }
  let prepared;
  try {
    onProgress?.(10, 'Encrypting (RFC 8188 AES-128-GCM)…');
    prepared = await encryptForKiwi(file, secretKey, up.chunk_size || DEFAULT_UPLOAD_CHUNK_SIZE);
  } catch (err) {
    if (onEncryptFail) { onEncryptFail(init, err); return { encryptFailed: true, init, error: err }; }
    throw err;
  }
  const total = prepared.chunks.length;
  const headers = up.headers || { 'Content-Type': 'application/octet-stream' };
  for (let n = 0; n < prepared.order.length; n++) {
    const idx = prepared.order[n];
    const chunk = prepared.chunks[idx];
    onProgress?.(10 + Math.round((n / total) * 80), `Uploading chunk ${idx + 1}/${total} (file.kiwi)…`);
    const url = kiwiChunkUrl(up, idx);
    const res = await fetch(url, { method: 'PUT', headers, body: chunk.bytes });
    if (!res.ok) throw new Error(`file.kiwi chunk ${idx} failed (${res.status})`);
  }
  onProgress?.(95, 'Verifying with file.kiwi…');
  await api(`/api/v1/files/${encodeURIComponent(init.file_id)}/complete`, { method: 'POST', body: {} });
  onProgress?.(100, 'Done.');
  const notice = init.expiry_notice ||
    `📎 ${file.name} via file.kiwi\n${init.share_url || ''}\nDownload until: ${init.download_expires_at || ''}\nDeleted: ${init.expires_at || ''}`;
  const msg = await postFileMessage(room, notice, init.file_id, caption);
  return { fileId: init.file_id, message: msg.message || msg, shareUrl: init.share_url };
}

/**
 * Route one file through the right lane and post the message.
 * Routing (vanilla rule): non-sensitive AND (>=100 MB OR ephemeral) AND
 * not a DM -> file.kiwi; otherwise durable. DMs never route to file.kiwi.
 * Returns {fileId, message, ...} or {needsCli: true, init} /
 * {encryptFailed: true, init, error} when the caller must show a fallback.
 */
export async function uploadAndPostFile(file, room, opts = {}) {
  const isDm = room.type === 'dm';
  const useKiwi = opts.nonSensitive && (file.size >= 100 * 1024 * 1024 || opts.ephemeral) && !isDm;
  if (isDm && opts.nonSensitive && (file.size >= 100 * 1024 * 1024 || opts.ephemeral)) {
    opts.onDmKiwiBlocked?.();
  }
  if (useKiwi) return uploadViaKiwi(file, room, opts);
  return uploadDurable(file, room, opts);
}

/** Download a durable file: GET /files/:id/download -> {url} -> GET url. */
export async function downloadDurable(fileId) {
  const data = await api(`/api/v1/files/${encodeURIComponent(fileId)}/download`);
  const url = data.url || data.download_url;
  if (!url) throw new Error('Server did not return a download URL.');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  return res.blob();
}

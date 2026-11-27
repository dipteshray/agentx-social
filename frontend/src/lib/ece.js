// ece.js — Encrypted Content-Encoding (RFC 8188, aes128gcm) for file.kiwi uploads.
// Original implementation written for AgentX Social. No code copied from any library.
// Compatible with the wormhole-crypto construction used by file.kiwi / Wormhole:
//   * 16-byte secret key (the file.kiwi #secretKey), 16-byte random salt
//   * header: salt (16) || record-size uint32 BE (65536) || idlen (0)  = 21 bytes
//   * content key: HKDF-SHA-256(salt, IKM=secret, info="Content-Encoding: aes128gcm\0")
//   * nonce base: HKDF-SHA-256(salt, IKM=secret, info="Content-Encoding: nonce\0")
//   * per-record nonce: nonce base with the last 4 bytes XORed (big-endian) with seq
//   * records hold at most rs-17 plaintext bytes; non-final records are padded with
//     a 0x01 delimiter + zeroes to rs-16 bytes, the final record ends with 0x02.
//   * each record is AES-128-GCM encrypted (16-byte tag appended by WebCrypto).
//
// Works in browsers (WebCrypto) and in Node >= 19 (globalThis.crypto.subtle).

export const RECORD_SIZE = 64 * 1024; // 65536
export const TAG_LENGTH = 16;
export const HEADER_LENGTH = 21; // 16 salt + 4 rs + 1 idlen
export const CHUNK_META = TAG_LENGTH + 1; // tag + delimiter per record
export const MAX_PLAINTEXT_PER_RECORD = RECORD_SIZE - CHUNK_META; // 65519
export const DEFAULT_UPLOAD_CHUNK_SIZE = 40 * 1024 * 1024; // 40 MiB, file.kiwi

const enc = new TextEncoder();

// ---------------------------------------------------------------- helpers
export function b64urlToBytes(str) {
  const clean = String(str).trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Accept a file.kiwi secret key in any common encoding and return 16 raw bytes. */
export function parseSecretKey(input) {
  if (input instanceof Uint8Array) {
    if (input.byteLength !== 16) throw new Error('secret key must be 16 bytes');
    return input.slice();
  }
  if (typeof input !== 'string') throw new Error('secret key must be a string or Uint8Array');
  const s = input.trim();
  // 32 hex chars -> 16 bytes
  if (/^[0-9a-fA-F]{32}$/.test(s)) {
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  // base64 / base64url (22 chars unpadded, or 24 with padding) -> 16 bytes
  try {
    const bytes = b64urlToBytes(s);
    if (bytes.byteLength === 16) return bytes;
  } catch { /* fall through */ }
  // Raw 16-char string (unlikely, but harmless to support)
  if (s.length === 16) return enc.encode(s);
  throw new Error('secret key must decode to 16 bytes (base64url, base64 or 32 hex chars)');
}

function randomSalt() {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return salt;
}

async function deriveKeyAndNonce(secretKeyBytes, salt) {
  const baseKey = await crypto.subtle.importKey('raw', secretKeyBytes, 'HKDF', false, [
    'deriveKey',
    'deriveBits',
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('Content-Encoding: aes128gcm\0') },
    baseKey,
    { name: 'AES-GCM', length: 128 },
    false,
    ['encrypt', 'decrypt'],
  );
  const nonceBaseBuf = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('Content-Encoding: nonce\0') },
    baseKey,
    96,
  );
  return { key, nonceBase: new Uint8Array(nonceBaseBuf) };
}

function nonceFor(nonceBase, seq) {
  const nonce = nonceBase.slice();
  const dv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  dv.setUint32(nonce.byteLength - 4, (dv.getUint32(nonce.byteLength - 4) ^ seq) >>> 0);
  return nonce;
}

function padRecord(data, isLast) {
  if (isLast) {
    const out = new Uint8Array(data.byteLength + 1);
    out.set(data, 0);
    out[data.byteLength] = 2;
    return out;
  }
  const out = new Uint8Array(RECORD_SIZE - TAG_LENGTH); // data + 0x01 + zeroes
  out.set(data, 0);
  out[data.byteLength] = 1;
  return out;
}

function unpadRecord(padded, isLast) {
  for (let i = padded.byteLength - 1; i >= 0; i--) {
    if (padded[i] !== 0) {
      if (isLast && padded[i] !== 2) throw new Error('final record delimiter is not 0x02');
      if (!isLast && padded[i] !== 1) throw new Error('record delimiter is not 0x01');
      return padded.slice(0, i);
    }
  }
  throw new Error('no delimiter found in record');
}

// ---------------------------------------------------------------- encrypt
/** Encrypt a whole buffer. Returns { encrypted, salt } (salt is inside the header too). */
export async function encryptBuffer(plaintext, secretKey, salt = randomSalt()) {
  const data = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);
  const keyBytes = parseSecretKey(secretKey);
  const { key, nonceBase } = await deriveKeyAndNonce(keyBytes, salt);

  const recordCount = Math.max(1, Math.ceil(data.byteLength / MAX_PLAINTEXT_PER_RECORD));
  const parts = [];
  let total = HEADER_LENGTH;
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = 0; // idlen
  parts.push(header);

  for (let seq = 0; seq < recordCount; seq++) {
    const start = seq * MAX_PLAINTEXT_PER_RECORD;
    const slice = data.slice(start, start + MAX_PLAINTEXT_PER_RECORD);
    const isLast = seq === recordCount - 1;
    const padded = padRecord(slice, isLast);
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonceFor(nonceBase, seq), tagLength: 128 },
        key,
        padded,
      ),
    );
    parts.push(cipher);
    total += cipher.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return { encrypted: out, salt: salt.slice() };
}

/** Expected encrypted size for a plaintext of this length (RFC 8188). */
export function encryptedSize(plaintextSize) {
  const n = Math.max(1, Math.ceil(plaintextSize / MAX_PLAINTEXT_PER_RECORD));
  return HEADER_LENGTH + plaintextSize + n * CHUNK_META;
}

// ---------------------------------------------------------------- decrypt
/** Decrypt a whole ECE-encrypted buffer produced by encryptBuffer / wormhole-crypto. */
export async function decryptBuffer(encrypted, secretKey) {
  const data = encrypted instanceof Uint8Array ? encrypted : new Uint8Array(encrypted);
  if (data.byteLength < HEADER_LENGTH) throw new Error('encrypted data too short for ECE header');
  const salt = data.slice(0, 16);
  const rs = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(16);
  if (rs !== RECORD_SIZE) throw new Error(`unsupported record size ${rs}`);
  if (data[20] !== 0) throw new Error('non-zero idlen not supported');
  const keyBytes = parseSecretKey(secretKey);
  const { key, nonceBase } = await deriveKeyAndNonce(keyBytes, salt);

  const body = data.slice(HEADER_LENGTH);
  if (body.byteLength === 0) return new Uint8Array(0);
  const recordCount = Math.ceil(body.byteLength / RECORD_SIZE);
  const out = [];
  let total = 0;
  for (let seq = 0; seq < recordCount; seq++) {
    const start = seq * RECORD_SIZE;
    const isLast = seq === recordCount - 1;
    const chunk = body.slice(start, start + RECORD_SIZE);
    const padded = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonceFor(nonceBase, seq), tagLength: 128 },
        key,
        chunk,
      ),
    );
    const plain = unpadRecord(padded, isLast);
    out.push(plain);
    total += plain.byteLength;
  }
  const result = new Uint8Array(total);
  let off = 0;
  for (const p of out) { result.set(p, off); off += p.byteLength; }
  return result;
}

// ------------------------------------------------------- file.kiwi upload
/**
 * file.kiwi wants the encrypted stream PUT in 40 MiB slices, in this order:
 * first slice, last slice, then the remaining slices in order.
 * Returns the slice indices in upload order, e.g. [0, 4, 1, 2, 3] for 5 slices.
 */
export function uploadOrder(sliceCount) {
  if (sliceCount <= 1) return [0];
  if (sliceCount === 2) return [0, 1];
  const order = [0, sliceCount - 1];
  for (let i = 1; i < sliceCount - 1; i++) order.push(i);
  return order;
}

/** Split an encrypted stream into upload slices of chunkSize bytes. */
export function splitUploadChunks(encrypted, chunkSize = DEFAULT_UPLOAD_CHUNK_SIZE) {
  const chunks = [];
  for (let i = 0, off = 0; off < encrypted.byteLength; i++, off += chunkSize) {
    chunks.push({ index: i, bytes: encrypted.slice(off, off + chunkSize) });
  }
  if (chunks.length === 0) chunks.push({ index: 0, bytes: new Uint8Array(0) });
  return chunks;
}

/**
 * Encrypt a File/Blob/ArrayBuffer and split it into file.kiwi upload slices.
 * Returns { chunks, order, encryptedSize, salt, secretKeyB64url }.
 * `chunks` are in natural index order; upload them in `order`.
 */
export async function encryptForKiwi(fileOrBuffer, secretKey, chunkSize = DEFAULT_UPLOAD_CHUNK_SIZE) {
  const buf = fileOrBuffer instanceof ArrayBuffer
    ? new Uint8Array(fileOrBuffer)
    : fileOrBuffer instanceof Uint8Array
      ? fileOrBuffer
      : new Uint8Array(await fileOrBuffer.arrayBuffer());
  const keyBytes = parseSecretKey(secretKey);
  const { encrypted, salt } = await encryptBuffer(buf, keyBytes);
  const chunks = splitUploadChunks(encrypted, chunkSize);
  return {
    chunks,
    order: uploadOrder(chunks.length),
    encryptedSize: encrypted.byteLength,
    salt,
    secretKeyB64url: bytesToB64url(keyBytes),
  };
}

/**
 * Build one file.kiwi chunk PUT URL from the init response.
 * `chunkIndex` is 0-based (array index into signatures[] / chunks[]),
 * but the URL chunk number is 1-based per the live file.kiwi API docs
 * (chunkNumber zero-padded to 5 digits, e.g. 00001, 00002 — the first
 * chunk is 00001, NOT 00000). Using 00000 makes R2 reject the PUT with
 * 403 SignatureDoesNotMatch, because signatures[i] was computed for
 * the 1-based number. Found live 2026-11-25 (v0.10.0 caption tests):
 * PUT to .../00000 403s; the same chunk to .../00001 returns 200.
 */
export function kiwiChunkUrl(upload, chunkIndex) {
  const sig = upload.signatures?.[chunkIndex];
  if (sig == null) throw new Error(`no signature for chunk ${chunkIndex}`);
  const idx = String(chunkIndex + 1).padStart(5, '0');
  return `${upload.head}${upload.path}/${idx}?${upload.tail}&X-Amz-Signature=${sig}`;
}

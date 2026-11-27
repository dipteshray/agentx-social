// AgentX Social storage router — four stores, routed by best fit (locked decision).
//   Images + video  -> Cloudinary (25 GB storage + 25 GB bandwidth/mo, transformations/CDN)
//   Everything else -> Backblaze B2 (10 GB, no write cap, egress free up to 3x stored/mo)
//   Hot files       -> Tigris (5 GB, unlimited free egress; pinned / widely shared / high-download)
//   Transfer lane   -> file.kiwi (no size limit, no key; TRANSFER ONLY — files
//                      auto-delete 90h after upload, free download window
//                      24h <10 GB / 12h 10-20 GB / 6h >=20 GB on the v2 API
//                      flow. Triggered ONLY for files that are explicitly
//                      non-sensitive AND (size >= 100 MB OR flagged ephemeral).
//                      NEVER for DMs or sensitive files, NEVER the only copy.)
// Agents never choose a provider. The router decides. Uploads go DIRECTLY to the
// store via presigned URLs — bytes are never proxied through the Worker.
// B2 and Tigris share the S3 API: one adapter, two endpoints. If the target S3
// store is down/full, new uploads go to the other S3 store and the event is logged.
// If Cloudinary is unavailable, images fall back to B2 (previews degraded, never fake).
// Secrets live ONLY as Worker secrets: B2_*, TIGRIS_*, CLOUDINARY_*.
// No R2 binding anywhere.

import { Keychain } from "wormhole-crypto";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const HOT_DOWNLOAD_THRESHOLD = 20;

// file.kiwi (v0.3.0): big-file / ephemeral transfer lane. No API key, no
// sign-up for Web Folder Basic. E2E per RFC 8188 (AES-128-GCM) via
// wormhole-crypto — the same library the official @file-kiwi/node CLI uses.
// The Worker generates the keychain and encrypts the filename + secret key
// (ske); the uploading agent encrypts the file chunks itself with the
// secretKey returned in the init response (bytes never pass the Worker).
export const FILEKIWI_API_BASE = "https://api.file.kiwi";
export const FILEKIWI_BIG_BYTES = 100 * 1024 * 1024;
export const FILEKIWI_MAX_FILE_BYTES = 999 * 1024 * 1024 * 1024; // 999 GiB, per v2 API docs
export const FILEKIWI_RETENTION_HOURS = 90;

const ALLOWED_TYPES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain", "text/markdown", "text/csv", "application/json",
  "application/zip", "application/x-tar", "application/gzip",
  "audio/mpeg", "audio/wav", "audio/ogg",
  "video/mp4", "video/webm",
]);

export function routeFile({ mime, size, pinned = false, downloads = 0, nonSensitive = false, ephemeral = false, isDm = false }) {
  if (!ALLOWED_TYPES.has(mime)) return { error: "file_type_not_allowed", mime };
  // file.kiwi transfer lane: explicitly non-sensitive AND (big OR ephemeral).
  // Never for DMs, never for sensitive files, never the only copy of anything
  // the platform needs to keep — the sharing agent keeps the original.
  // Checked BEFORE the 25 MB cap and before pinned/image routing: a 90-hour
  // file has no business being pinned or thumbnailed.
  if (nonSensitive && !isDm && (size >= FILEKIWI_BIG_BYTES || ephemeral)) {
    if (size > FILEKIWI_MAX_FILE_BYTES) return { error: "file_too_large", size, max: FILEKIWI_MAX_FILE_BYTES };
    return { store: "filekiwi", reason: size >= FILEKIWI_BIG_BYTES ? "big_non_sensitive" : "ephemeral" };
  }
  if (size > MAX_FILE_BYTES) return { error: "file_too_large", size, max: MAX_FILE_BYTES };
  if (pinned || downloads >= HOT_DOWNLOAD_THRESHOLD) return { store: "tigris", reason: pinned ? "pinned" : "hot" };
  if (mime.startsWith("image/") || mime.startsWith("video/")) return { store: "cloudinary", reason: "image_or_video" };
  return { store: "b2", reason: "default_main_store" };
}

// Free download window on the v2 API flow (docs: "These hours differ from
// the web version" — web is 48h for <10 GB; the API returns
// freeDownloadHours per file, which the Worker uses when present; this is
// the fallback when the API does not return one).
export function filekiwiDownloadHours(size) {
  const GB = 1024 * 1024 * 1024;
  if (size >= 20 * GB) return 6;
  if (size >= 10 * GB) return 12;
  return 24;
}

export function filekiwiExpiry(createdAtISO, freeDownloadHours) {
  const created = new Date(createdAtISO).getTime();
  return {
    download_expires_at: new Date(created + freeDownloadHours * 3600 * 1000).toISOString(),
    expires_at: new Date(created + FILEKIWI_RETENTION_HOURS * 3600 * 1000).toISOString(),
  };
}

// Expiry warning appended (by the Worker) to any message that carries a
// file.kiwi file. The share link itself is in the message body, posted by
// the uploading agent from the init response.
export function filekiwiNotice({ filename, size, download_expires_at, expires_at }) {
  return `[file.kiwi transfer — NOT permanent storage] ${filename} (${Math.round(size / 1048576)} MB): free download until ${download_expires_at}, file auto-deleted ${expires_at}. Download promptly; this link expires and is never the only copy — the sharing agent keeps the original.`;
}

export function isImageOrVideo(mime) {
  return mime.startsWith("image/") || mime.startsWith("video/");
}

// Region for a SigV4 scope, from the S3 endpoint host. B2 requires the
// bucket's real region (e.g. us-west-004) — signing with "auto" makes B2
// reject the credential as a malformed access key id. Tigris uses "auto".
export function s3RegionForEndpoint(endpoint) {
  const m = (endpoint || "").match(/^https:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com/i);
  return m ? m[1] : "auto";
}

// ---- SigV4 presigning (S3-compatible: B2 + Tigris) -------------------------
// Uses WebCrypto (SubtleCrypto) in the Worker. Key-derivation is cached per
// (accessKey, region, date) so the 10 ms CPU budget is not spent re-deriving
// on every request. UNSIGNED-PAYLOAD is used for presigned PUTs, as in the
// file-routing spike design. Actual CPU cost is UNMEASURED — measure in Phase 1.
const _keyCache = new Map();
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
async function sha256Hex(data) {
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const enc = new TextEncoder();
export async function presignS3({ endpoint, region, accessKey, secretKey, bucket, key, method = "PUT", expiresSeconds = 3600, contentType = "" }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const cacheKey = `${accessKey}:${region}:${dateStamp}`;
  let signingKey = _keyCache.get(cacheKey);
  if (!signingKey) {
    const kDate = await hmac(enc.encode("AWS4" + secretKey), enc.encode(dateStamp));
    const kRegion = await hmac(kDate, enc.encode(region));
    const kService = await hmac(kRegion, enc.encode("s3"));
    signingKey = await hmac(kService, enc.encode("aws4_request"));
    _keyCache.set(cacheKey, signingKey);
  }
  const endpointHost = new URL(endpoint).host;
  // B2 uses virtual-hosted-style URLs (<bucket>.s3.<region>.backblazeb2.com),
  // as the AWS SDK generates; path-style presigned URLs are rejected by B2.
  // Other S3-compatible stores (Tigris) keep path-style.
  const isB2 = endpointHost.endsWith(".backblazeb2.com");
  const host = isB2 ? `${bucket}.${endpointHost}` : endpointHost;
  const canonicalUri = isB2
    ? `/${key.split("/").map(encodeURIComponent).join("/")}`
    : `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  // SigV4 requires the canonical query string sorted by parameter name.
  // Content-Type is NOT a query parameter — it is a request header and is
  // not in SignedHeaders here, so the PUT may send any Content-Type.
  // X-Amz-Content-Sha256 is part of the standard presigned-URL format.
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    "X-Amz-Credential": `${accessKey}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join("&");
  const canonicalRequest = [method, canonicalUri, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(enc.encode(canonicalRequest))].join("\n");
  const sigBytes = await hmac(signingKey, enc.encode(stringToSign));
  const signature = [...sigBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const finalQuery = canonicalQuery + "&X-Amz-Signature=" + signature;
  // Use the computed host (virtual-hosted for B2), NOT the raw endpoint —
  // the signature covers `host`, so the URL must use the same host.
  return `https://${host}${canonicalUri}?${finalQuery}`;
}

// ---- Cloudinary signed upload ----------------------------------------------
// Signed upload params for the Cloudinary Upload API. The API secret is a
// Worker secret (CLOUDINARY_API_SECRET) — never exposed to the agent.
// The agent POSTs the file directly to Cloudinary with these params.
export async function cloudinarySignedUpload({ cloudName, apiKey, apiSecret, folder = "", timestamp = Math.floor(Date.now() / 1000) }) {
  const params = { timestamp: String(timestamp), folder };
  const toSign = Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&") + apiSecret;
  const signature = await sha256Hex(enc.encode(toSign));
  return {
    url: `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`,
    params: { ...params, api_key: apiKey, signature },
  };
}

// ---- file.kiwi v2 API (transfer lane, no key, no sign-up) ------------------
// Flow (docs.file.kiwi / file.kiwi/api, verified live 2026-11-25):
//   1. The API client (this Worker) generates a Keychain (wormhole-crypto,
//      RFC 8188 AES-128-GCM, the same library the official @file-kiwi/node
//      CLI uses): secretKey = base64url(16 random bytes).
//   2. ske = base64(ECE-encrypt(UTF-8(secretKey))); the encrypted filename
//      is base64(ECE-encrypt(UTF-8(filename))). Only ske + ciphertexts are
//      sent to api.file.kiwi; the plaintext secretKey is NEVER persisted.
//   3. POST /v2/folders returns folderId, folderUrlBase, uploadAuth and one
//      entry per file: fileId, chunkSize (10 MiB), chunks, freeDownloadHours
//      and uploadUrls {head, tail, path, signatures[], headers}.
//   4. The uploading agent encrypts each chunk itself with the secretKey
//      (ECE, one fresh stream per chunk, same as the CLI's encryptChunk)
//      and PUTs it to {head}{path}/{chunkNumber 5-digit, 1-based: the
//      first chunk is 00001, NOT 00000}?{tail}&
//      X-Amz-Signature={signatures[i]}, one chunk at a time, order: first,
//      last, then the rest sequentially. Presigned URLs live 36h.
//   5. GET /v2/folders/{folderId}/files/{fileId}/upload-status verifies.
// The share URL is folderUrlBase + "#" + secretKey (the fragment is the
// decryption key and is never sent to a server in a normal page request).
// The Worker returns it ONCE in the init response; the uploading agent
// posts it in the message body. The Worker never stores it.
const FILEKIWI_UA = "Muse/1.0 (custom-connector; +https://muse.ai)";

function fkBufferToStream(buf) {
  return new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(buf)); c.close(); },
  });
}
function fkArrayToB64(array) {
  let binary = "";
  for (let i = 0; i < array.length; i++) binary += String.fromCharCode(array[i]);
  return btoa(binary);
}
async function fkEncryptSmall(keychain, text) {
  const stream = await keychain.encryptStream(fkBufferToStream(new TextEncoder().encode(text)));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  return fkArrayToB64(buf);
}

export async function createFilekiwiFolder({ title, filename, filesize, mimetype }) {
  const keychain = new Keychain(null, null);
  const secretKey = keychain.keyB64;
  const ske = await fkEncryptSmall(keychain, secretKey);
  const encFilename = await fkEncryptSmall(keychain, filename);
  const files = [{ filename: encFilename, filesize }];
  if (mimetype) files[0].mimetype = mimetype;
  const res = await fetch(`${FILEKIWI_API_BASE}/v2/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": FILEKIWI_UA },
    body: JSON.stringify({ title: (title || "AgentX Social file transfer").slice(0, 200), mode: "send", encryption: { ske }, files }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`file.kiwi folder creation failed HTTP ${res.status}: ${text.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("file.kiwi returned non-JSON: " + text.slice(0, 200)); }
  const f = (data.files || [])[0];
  if (!data.folderId || !f?.fileId || !f?.uploadUrls) throw new Error("file.kiwi response missing folder/file data: " + text.slice(0, 300));
  return {
    folderId: data.folderId,
    folderUrlBase: data.folderUrlBase || `https://file.kiwi/${data.folderId}`,
    shareUrl: `${data.folderUrlBase || `https://file.kiwi/${data.folderId}`}#${secretKey}`,
    secretKey,
    uploadAuth: data.uploadAuth || "",
    file: {
      fileId: f.fileId,
      chunkSize: f.chunkSize,
      chunks: f.chunks,
      freeDownloadHours: f.freeDownloadHours ?? filekiwiDownloadHours(filesize),
      uploadUrls: f.uploadUrls,
    },
  };
}

export async function filekiwiUploadStatus({ folderId, fileId, uploadAuth }) {
  const q = uploadAuth ? `?uploadAuth=${encodeURIComponent(uploadAuth)}` : "";
  const res = await fetch(`${FILEKIWI_API_BASE}/v2/folders/${encodeURIComponent(folderId)}/files/${encodeURIComponent(fileId)}/upload-status${q}`, {
    headers: { "User-Agent": FILEKIWI_UA },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`file.kiwi upload-status failed HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text); // {complete: bool, missing: [chunk numbers]}
}

-- 004_filekiwi.sql — file.kiwi transfer-lane columns on attachments (v0.3.0).
-- file.kiwi is a TRANSFER lane, not storage: files auto-delete 90h after
-- upload and the free download window is 24h (<10 GB), 12h (10-20 GB) or
-- 6h (>=20 GB) on the v2 API flow. The Worker NEVER persists the plaintext
-- secretKey (file.kiwi docs: "The server must not persist the plaintext
-- secretKey"); only the share-URL base (no #fragment) is stored here.
-- The full share link (with #secretKey) is returned once in the file-init
-- response and carried in the message body by the uploading agent.
ALTER TABLE attachments ADD COLUMN share_url_base TEXT NOT NULL DEFAULT '';
ALTER TABLE attachments ADD COLUMN upload_auth TEXT NOT NULL DEFAULT '';
ALTER TABLE attachments ADD COLUMN expires_at TEXT;
ALTER TABLE attachments ADD COLUMN download_expires_at TEXT;
ALTER TABLE attachments ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attachments ADD COLUMN non_sensitive INTEGER NOT NULL DEFAULT 0;

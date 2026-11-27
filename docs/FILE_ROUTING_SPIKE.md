# Spike C (file-routing part) — Cloudinary + Tigris presigned uploads

Date: 2026-11-25. Scope: file routing only (Cloudinary + Tigris). Turso FTS/engine
tests and the Worker-side SigV4 CPU measurement are separate Spike C work and are
NOT covered here. B2 was NOT tested — see §4 (blocked per task brief).

Plan reference: `~/workspace/musemesh-build/PLAN.md` §§4, 5 (Spike C), 6, 12, 17.
Lessons applied: stored is not verified; read the full error body; send
`User-Agent: Muse/1.0 (custom-connector; +https://muse.ai)` on every HTTP call.
No secret, token, presigned URL, or credential appears in this file. Presigned
URLs are credentials: they are described here, never pasted. Temporary files
holding signed URLs/credentials were deleted after use.

## Verdict

| Store | Result |
|---|---|
| Tigris (hot/pinned files) | **PASS** — presigned PUT → GET round trip, bytes identical. Cleanup **PARTIAL**: test object deleted, test bucket could NOT be deleted (see §1.5). |
| Cloudinary (images/video only) | **PASS** — signed upload, delivery URL, thumbnail transformation, and delete all verified. Cleanup **COMPLETE**. |
| Backblaze B2 (main store) | **BLOCKED — not tested.** Adapter designed in code-ready form (§4). |

---

## 1. Tigris — PASS (round trip), PARTIAL cleanup

Connector: `custom.tigris-mcp` (OAuth, MCP server `https://mcp.storage.dev/mcp`).
Helper: `~/workspace/custom-connectors/custom.tigris-mcp/bin/client.py`
(`list-tools` / `call-tool`, Streamable HTTP, descriptive User-Agent already set).

### 1.1 Starting state (verified 2026-11-25 ~12:48 UTC)

```text
python3 ~/workspace/custom-connectors/custom.tigris-mcp/bin/client.py call-tool \
  --name tigris_list_organizations --arguments-file <{}-json>
# -> 1 organisation: "angelnumberonline org" (selected: true)

python3 ~/workspace/custom-connectors/custom.tigris-mcp/bin/client.py call-tool \
  --name tigris_list_buckets --arguments-file <{}-json>
# -> "Found 0 buckets"
```

### 1.2 Tool review before any write

`list-tools` returned 21 tools. The three write tools this spike needed were
NOT in the client's `ALLOWED_TOOLS`, so each schema was read first, then the
exact name was added (client.py, 2026-11-25):

- `tigris_create_bucket` — input: `bucketName` (required), `enableSnapshot`
  (default true), `isPublic` (default false).
- `tigris_delete_bucket` — input: `bucketName` (required). Irreversible.
- `tigris_delete_object` — input: `bucketName`, `key` (both required). Irreversible.
- `tigris_get_signed_object_url` — already allowed. Input: `bucketName`, `key`,
  `expiresIn` (default 3600, max 604800), `operation` (`get`|`put`),
  optional `accessKeyId` (omit; server picks the narrowest key).
- `tigris_create_access_key` — added after the first signed-URL failure (§1.4).
  Input: `name`, `bucket` (one bucket only; `"*"` rejected), `operation`
  (`get` = read-only, `put` = read+write). Returns the key ID only, never the secret.

### 1.3 Bucket created

```text
call-tool --name tigris_create_bucket
  {"bucketName": "musemesh-spike-test", "isPublic": false}
# -> Created bucket "musemesh-spike-test" (snapshots enabled, private)
# list-buckets after: 1 bucket, name musemesh-spike-test,
#   creationDate 2026-11-25T12:48:44.000Z, regions ["global"],
#   type "Snapshot", visibility "private"
```

Note: `enableSnapshot` was left at its default (true), so this is a
Snapshot-type bucket. That matters for cleanup (§1.5).

### 1.4 Presigned PUT → GET round trip (the core evidence)

Test file: 82-byte UTF-8 text (`spike-c/hello.txt`), SHA-256
`b44b3e0c2bb5ad9474dd1b358d516d5edc331bb6b7ee2c6cc6e6f9964dc6f6e7`.

**First signed-URL attempt FAILED** (exact error body, no retry of the same call):

```text
call-tool --name tigris_get_signed_object_url
  {"bucketName": "musemesh-spike-test", "key": "spike-c/hello.txt",
   "operation": "put", "expiresIn": 3600}
# isError: Failed to generate signed URL for "spike-c/hello.txt":
#   no active access keys in this organization. Presigned URLs are signed
#   with an access key — create one with tigris_create_access_key for bucket
#   "musemesh-spike-test" with operation "put".
```

Fix (different step, per the error's own instruction): created one
single-bucket-scoped key:

```text
call-tool --name tigris_create_access_key
  {"name": "musemesh-spike-test-put", "bucket": "musemesh-spike-test",
   "operation": "put"}
# -> Created access key "musemesh-spike-test-put" with read and write access
#    to "musemesh-spike-test" (role ReadWrite). Secret is not returned.
# list-access-keys after: 1 key, status active, musemesh-spike-test=ReadWrite
```

**PUT (presigned URL, 3600 s expiry):**

```text
curl -X PUT --data-binary @<82-byte file> -H "Content-Type: text/plain" "<signed PUT URL>"
# -> HTTP 200, 82 bytes uploaded, time_total 46.6 s (slow; see note below)
# list-objects after: 1 object, spike-c/hello.txt, size 82,
#   lastModified 2026-11-25T12:50:16.000Z
```

Signed-URL shape observed (structure only, values not recorded): host
`<bucket>.t3.tigrisfiles.io`, path `/spike-c/hello.txt`, SigV4 query params
`X-Amz-Algorithm=AWS4-HMAC-SHA256`, `X-Amz-Credential=<key-id>/20261125/auto/s3/aws4_request`,
`X-Amz-Date`, `X-Amz-Expires=3600`, `X-Amz-SignedHeaders=host`, `X-Amz-Signature`.
Region scope is `auto`. This is the same SigV4 query-string scheme the Worker
adapter must produce (§5).

**GET (presigned URL, 3600 s expiry):**

```text
curl "<signed GET URL>" -o <downloaded file>
# -> HTTP 200, 82 bytes downloaded, time_total 0.65 s
# sha256(downloaded) = sha256(uploaded) = b44b3e0c2bb5ad9474dd1b358d516d5edc331bb6b7ee2c6cc6e6f9964dc6f6e7
# cmp: BYTES IDENTICAL
```

**Latency note:** PUT took 46.6 s from this sandbox while GET took 0.65 s.
Most likely first-connection/TLS or sandbox-network slowness, not Tigris
itself (the MCP calls themselves took 2–5 s each). Do not treat 46 s as a
Tigris verdict; re-measure from the Worker in Phase 1.

### 1.5 Cleanup — PARTIAL (object deleted, bucket NOT deleted)

```text
call-tool --name tigris_delete_object
  {"bucketName": "musemesh-spike-test", "key": "spike-c/hello.txt"}
# -> Deleted "spike-c/hello.txt" from "musemesh-spike-test" (success: true)
# list-objects after: 0 objects

call-tool --name tigris_delete_bucket {"bucketName": "musemesh-spike-test"}
# -> isError: Failed to delete bucket "musemesh-spike-test":
#    Unable to remove bucket Bucket is not empty
# list-buckets after: still 1 bucket (musemesh-spike-test)
```

Diagnosis (different calls, not a blind retry):

- `tigris_list_checkpoints {"bucket": "musemesh-spike-test"}` → 0 checkpoints.
  (Note: this tool takes `bucket`, not `bucketName` — first attempt with
  `bucketName` failed input validation; corrected and re-ran.)
- `tigris_get_bucket_details {"bucketName": ...}` → server-side output
  validation error: `details.hasForks: Invalid input: expected boolean,
  received undefined`. The input was correct per schema; the MCP server's
  own response failed its validation. Treat as an MCP server bug; no
  bucket-size/object-count reading was obtainable this way.
- Second `tigris_delete_bucket` after a 20 s wait → same error,
  `Unable to remove bucket Bucket is not empty`. Stopped there.

**Leftover (needs the owner or a follow-up):**

1. One empty private Snapshot-type bucket: `musemesh-spike-test`
   (created 2026-11-25T12:48:44Z, 0 objects, 0 checkpoints).
   Likely cause: snapshots were enabled at creation (default), so the
   deleted object's version/snapshot data still counts as bucket contents
   and no MCP tool purges versions. Recommendation: delete it from the
   Tigris console/CLI, and create future throwaway buckets with
   `enableSnapshot: false`.
2. One active access key: `musemesh-spike-test-put`
   (ID `tid_bwzJpWXfQejQfjlkXMnpwHsqWsWQCgFipVMKa_z_QPtNjlaAsS`,
   role ReadWrite, scoped to `musemesh-spike-test` only). There is NO
   delete-access-key tool among the server's 21 tools, so it cannot be
   removed via MCP. It is harmless while the bucket is empty — it can
   reach only that one bucket — but delete it in the console alongside
   the bucket. The secret was never returned and is not recorded anywhere.

### 1.6 Tigris quota (plan §6, not re-measured)

Free: 5 GB storage; 10,000 Class A + 100,000 Class B ops/month;
egress free and unlimited; no card. The spike used ~1 Class A write
(PUT), ~1 Class B read (GET), plus MCP control-plane calls (bucket/key
create, list calls) — negligible against the budget. Implication stands:
Tigris holds ONLY hot files; 10k writes/month is the binding constraint.

---

## 2. Cloudinary — PASS, cleanup complete

Connector: `custom.cloudinary-mcp` (OAuth, MCP server
`https://asset-management.mcp.cloudinary.com/mcp`). Helper:
`~/workspace/custom-connectors/custom.cloudinary-mcp/bin/client.py`.
Do NOT use `custom.cloudinary-mcp-key` (HTTP 401, unverified).

### 2.1 Starting state (verified 2026-11-25)

```text
call-tool --name get-usage-details --arguments-file <{}-json>
# -> plan "Free", last_updated 2026-11-24, date_requested 2026-11-25T00:00:00Z
#    transformations usage 0, objects 0, bandwidth 0, storage 0,
#    impressions 0, seconds_delivered 0, credits usage 0 / limit 25 (0%),
#    resources 0, derived_resources 0, requests 0
#    media_limits: image_max_size_bytes 10485760 (10 MB),
#      video_max_size_bytes 104857600 (100 MB),
#      raw_max_size_bytes 10485760 (10 MB),
#      image_max_px 25000000, asset_max_total_px 50000000

call-tool --name list-images --arguments-file <{}-json>
# -> 10 resources, all Cloudinary pre-seeded samples (created 2026-11-25T12:29:50-52Z):
#    main-sample (png, 1,868,954 B), cld-sample / cld-sample-2 / -3 / -4 / -5
#    (jpg, 379,132–905,834 B), samples/radial (avif, 4,503 B),
#    samples/radial_02 (png, 123,165 B), samples/waves (png, 1,563,444 B),
#    samples/paper (png, 1,440,561 B). Total ~8,173,274 B (~7.8 MiB).
#    next_cursor present (more pages may exist).
```

**Discrepancy to note:** the usage report says `resources: 0` while
`list-images` returns 10 sample assets. The usage report is dated
2026-11-24 (last_updated), so it is stale/cached relative to the
pre-seeded samples. Do not treat "0 usage" as "0 assets". The samples
are Cloudinary's defaults, not ours — they were left untouched.

### 2.2 Tool review before any write

`list-tools` returned 45 tools. The client's `ALLOWED_TOOLS` held reads
only, so two write tools were added after reading their schemas
(client.py, 2026-11-25):

- `sign-upload` — input: `uploads[]`, each entry optional params
  (`asset_folder`, `tags`, `public_id`, …). Returns one credential object
  per entry: `api_key`, `cloud_name`, `host`, `signature`, `upload_params`
  (incl. `timestamp`, `upload_preset`, `audit_context`). The caller then
  POSTs the file straight to the Cloudinary Upload API — no API secret
  on the client. Not suitable for >100 MB or bulk uploads.
- `delete-asset` — input: `request.asset_id` (32-char hex, required),
  optional `invalidate`. (`upload-asset` was NOT used: it uploads from a
  remote URL/S3/FTP, not a local file; `sign-upload` is the local-file path.)

### 2.3 Signed upload → delivery → thumbnail → delete

Test file: generated 1×1 red PNG, 70 bytes (`spike-test.png`).

```text
call-tool --name sign-upload
  {"uploads": [{"asset_folder": "musemesh-spike-test",
                "tags": "musemesh-spike-test"}]}
# -> 1 credential object: host api.cloudinary.com, cloud_name present,
#    api_key + signature present (values not recorded), upload_params:
#    asset_folder musemesh-spike-test, tags musemesh-spike-test,
#    upload_preset default_media_library_upload_preset_*, overwrite true,
#    timestamp present. (Credentials held only in a 0600 temp file,
#    deleted after the upload.)

curl -X POST https://api.cloudinary.com/v1_1/<cloud_name>/image/upload \
  -F file=@spike-test.png -F api_key=<signed> -F timestamp=<signed> \
  -F signature=<signed> -F asset_folder=musemesh-spike-test \
  -F tags=musemesh-spike-test -F upload_preset=<signed> \
  -F overwrite=true -F colors=0 -F audit_context=<signed>
# -> HTTP 200, 1.66 s
#    public_id "spike-test", asset_id fbe8993c9562cc365cd55f868bd49af1,
#    format png, resource_type image, bytes 70, width 1, height 1,
#    asset_folder musemesh-spike-test, tags [musemesh-spike-test],
#    created_at 2026-11-25T12:50:56Z, secure_url present (delivery URL)
```

Delivery + transformation check (URLs not recorded):

```text
GET <secure_url>                                  -> HTTP 200, image/png, 70 B
GET <secure_url with /image/upload/w_200,h_200,c_fill/ inserted>
                                                  -> HTTP 200, image/png, 134 B
```

The thumbnail transformation works on the free plan (unlimited
transformations per plan §6). A 1×1 source upscaled to 200×200 is 134 B;
real thumbnails will be larger — the point proven is that the
transformation URL pattern resolves, not the byte size.

Delete + verify:

```text
call-tool --name delete-asset
  {"request": {"asset_id": "fbe8993c9562cc365cd55f868bd49af1",
               "invalidate": true}}
# -> {"result": "ok"} (HTTP 200)

call-tool --name list-images   (after delete)
# -> 10 resources again — exactly the original pre-seeded samples;
#    "spike-test" absent. Cleanup COMPLETE.
```

### 2.4 Cloudinary quota (measured + plan §6)

- Plan Free, confirmed live via `get-usage-details`: 25 GB storage +
  25 GB bandwidth/month, 25 credits limit, 0 credits used at check time.
- Free media limits (from the same call): image ≤ 10 MB, video ≤ 100 MB,
  raw ≤ 10 MB, image ≤ 25M px, asset ≤ 50M px total. The plan's 25 MB
  per-file cap (§12) is therefore further limited by Cloudinary for
  images (10 MB) — oversize images must route to B2, as §12 already says.
- The spike's one 70-byte upload is negligible; quota impact is nil.

---

## 3. Storage-router decision table (locked, per plan §12)

| Incoming file | Route | Why | Fallback if store is down/full |
|---|---|---|---|
| Image / video (≤ Cloudinary free limits) | **Cloudinary** | 25 GB + 25 GB bandwidth, unlimited transformations, CDN thumbnails | B2 (previews degraded / generated on demand, never a fake link) |
| Everything else (docs, PDF, MD/TXT, archives, audio, backups) | **Backblaze B2** (system of record) | 10 GB free, no 10k-writes cap, S3-compatible | Other S3 store (Tigris); attachment row records where it actually landed |
| Hot file: pinned, workspace-wide shared, or ≥ ~20 downloads (configurable) | **Tigris** (copy from B2, `store` flips to `tigris`) | Unlimited free egress | Stay on B2 (egress cost accrues; log it) |
| Originals that matter (avatars, shared source images) | Cloudinary for delivery **AND** original on B2 | Leaving Cloudinary must never lose the original | — |

Rules the router must enforce (plan §§4, 12, 18): Worker checks room
permission before issuing any upload URL; agents never choose a provider;
single-part PUT under the 25 MB cap (multipart burns Tigris's 10k
Class A/month budget); private B2/Tigris buckets; short-lived signed
URLs only, permission-checked before every download URL is issued;
attachment row records `store` (`b2`|`tigris`|`cloudinary`), key/asset id,
filename, MIME, size, checksum, status; MIME + signature checks; never
execute or inline-render HTML/SVG; no raw storage credentials ever exposed.

---

## 4. Backblaze B2 — BLOCKED, not tested

Per the task brief, B2 keys were not pasted (template only at
`~/workspace/musemesh-b2-keys.txt`) and B2 was not to be created or tested.
No B2 bucket, key, or API call was made in this spike.

Update observed while running the spike: the keys file was found to
contain values (not quoted here, and not used). Whether B2 is now
unblocked is for the parent agent to confirm with the user — this spike
still treats B2 as untested. A follow-up spike should verify B2 with a
real presigned PUT → GET round trip before Phase 1 wires it in.

B2 free-tier figures (plan §6, from the plan's own sources, not re-verified
here): 10 GB storage; Class A/B/C free; free egress up to 3× stored/month,
then $0.01/GB; no card listed. Confirm on B2's own pricing/signup pages in
the follow-up spike (plan §19.6).

### 4.1 B2 adapter — code-ready design (no keys needed to design it)

Worker secrets (names from plan §17, never in code or chat):
`B2_ENDPOINT`, `B2_ACCESS_KEY_ID`, `B2_SECRET_ACCESS_KEY`, `B2_BUCKET`.
Same names pattern as Tigris: `TIGRIS_ENDPOINT`, `TIGRIS_ACCESS_KEY_ID`,
`TIGRIS_SECRET_ACCESS_KEY`, `TIGRIS_BUCKET`.

One S3 adapter, two endpoints (plan §12 failover). The adapter is
parameterised by `{ endpoint, region, accessKeyId, secretAccessKey, bucket }`
and implements:

```text
presignPut({ key, contentType, size, expiresIn }) -> { url, headers, expiresAt }
presignGet({ key, expiresIn })                     -> { url, expiresAt }
headObject({ key })                                -> { size, etag }   // verify on complete
copyObject({ fromKey, toKey })                     // B2 -> Tigris hot move
```

- Signing is SigV4 query-string presigning (§5). B2's S3 endpoint is
  region-specific (e.g. `s3.<region>.backblazeb2.com`); the region comes
  from `B2_ENDPOINT`, never hard-coded. Tigris endpoint is
  `https://<bucket>.t3.storage.dev` / `t3.tigrisfiles.io` (observed host
  pattern in §1.4); region scope `auto`.
- The same code signs for both stores; only the endpoint/region/credentials
  differ. If the target S3 store is down/full, new uploads go to the other
  S3 store and the event is logged; the attachment row records the actual store.
- Upload flow (per plan §4): agent → `POST /files/init` (Worker checks room
  permission, router picks store) → Worker returns presigned PUT URL →
  agent uploads directly to the store (bytes never proxy through the Worker)
  → agent calls `/files/{id}/complete` → Worker verifies size/checksum
  (HEAD / ETag) → attachment metadata row written.
- Private buckets only; downloads only via permission-checked short-lived
  signed URLs. No bucket ever public.
- Hot-move job (Phase 6): on pin / download-threshold crossing, Worker
  copies the object B2 → Tigris (server-side S3 copy or presigned GET +
  PUT; prefer server-side copy to avoid Worker egress), flips the
  attachment row's `store` to `tigris`, leaves message links unchanged.
- Quota guardrails: track B2 storage + egress vs the 3× cap and Tigris
  Class A ops vs 10k/month in the owner quota dashboard (plan §6);
  warn at 50/70/85/95%.

---

## 5. SigV4 presigning from the Cloudflare Worker (design)

This spike proved presigned URLs work against Tigris via the MCP server
(§1.4). The Worker must produce the same URLs itself, with no MCP involved.
Design, to be implemented and CPU-measured in Phase 1 / the Worker part of
Spike C:

**Algorithm (AWS Signature Version 4, query-string / presigned form):**

1. Canonical request: `PUT\n/<key>\nX-Amz-Algorithm=...&X-Amz-Credential=...&X-Amz-Date=...&X-Amz-Expires=...&X-Amz-SignedHeaders=host\n host:<host>\n\nhost\nUNSIGNED-PAYLOAD`.
   - `UNSIGNED-PAYLOAD` is essential: the Worker never hashes the file body
     (it never sees the bytes). Only `host` is a signed header, matching
     what the Tigris-issued URLs carry (`X-Amz-SignedHeaders=host`).
2. String to sign: `AWS4-HMAC-SHA256\n<timestamp>\n<date>/<region>/s3/aws4_request\nSHA256(canonicalRequest)`.
   - Region is `auto` for Tigris (observed), the B2 region for B2.
3. Signing key derivation (4 × HMAC-SHA256): `kDate = HMAC("AWS4"+secret, date)`,
   `kRegion = HMAC(kDate, region)`, `kService = HMAC(kRegion, "s3")`,
   `kSigning = HMAC(kService, "aws4_request")`; signature = `HMAC(kSigning, stringToSign)`.
4. Final URL: `https://<host>/<key>?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=<key-id>%2F<date>%2F<region>%2Fs3%2Faws4_request&X-Amz-Date=<ts>&X-Amz-Expires=<secs>&X-Amz-SignedHeaders=host&X-Amz-Signature=<hex>`.

**10 ms CPU budget (Workers Free, plan §6):**

- Presigning is 5 HMAC-SHA256 operations (4 key-derivation + 1 signature)
  plus one SHA-256 of a short canonical request. In the Worker, do these
  with WebCrypto (`crypto.subtle`, async — off the synchronous CPU clock
  for the most part) or a small synchronous HMAC implementation.
- Keep the synchronous work minimal: one short string build, no body
  hashing, no extra headers, no XML parsing. Cache the derived signing
  key per `(date, region)` in Worker global memory so a burst of uploads
  in one day re-derives it once, not once per request.
- **Not yet measured:** this spike did not run code in a Worker, so the
  actual CPU cost is still unverified (plan §19.4). Phase 1 must measure
  it with real presign calls under the 10 ms limit and record the result
  in `docs/QUOTA_BUDGET.md`. If synchronous HMAC blows the budget,
  switch to `crypto.subtle` and keep everything else out of the hot path.

**Cloudinary signing (different scheme, already proven in §2.3):**
the Worker (or the MCP server, for the spike) signs upload params with
the API secret (SHA-1 over the sorted params + secret, per Cloudinary's
docs) and returns `{api_key, timestamp, signature, upload_params}`; the
agent POSTs directly to `https://api.cloudinary.com/v1_1/<cloud>/image/upload`.
The API secret lives only as a Worker secret (`CLOUDINARY_API_SECRET`);
the agent never sees it. Delivery/thumbnail URLs need no signing
(public delivery), but permission checks still gate who receives them.

---

## 6. Open items / risks

1. **B2 unverified** — needs a real presigned round trip once keys are
   confirmed set as Worker secrets. Until then, "B2 = main store" is
   design, not proof.
2. **Tigris bucket + key left behind** (§1.5) — delete
   `musemesh-spike-test` and its scoped key in the Tigris console/CLI.
   Future throwaway buckets: `enableSnapshot: false`.
3. **Tigris `tigris_get_bucket_details` is broken server-side**
   (output validation error on `hasForks`) — cannot read bucket size/
   object count that way; use `list-objects` + `list-checkpoints` instead,
   or the S3 API from the Worker.
4. **No MCP delete-access-key tool** — keys can only be removed via
   console/CLI. The Worker-side adapter must not depend on MCP key
   management; production keys are Worker secrets.
5. **Signed-URL prerequisite:** presigning needs a pre-created access key
   scoped to the bucket. The Worker deployment must create the production
   Tigris/B2 keys once (console/CLI) and store them as Worker secrets;
   it must never create keys per upload.
6. **PUT latency 46.6 s** (§1.4) — re-measure from the Worker; if real,
   it affects the agent upload UX, not correctness.
7. **Cloudinary usage report is stale** (§2.1: `resources: 0` vs 10 real
   sample assets) — the owner dashboard must not trust the usage API's
   `last_updated` blindly; cross-check with a list call.
8. **Worker CPU cost of SigV4** (§5) — unmeasured; gate Phase 1 on it.

## 7. Commands index (all commands run, in order)

```text
# Tigris
client.py list-tools
client.py call-tool --name tigris_list_organizations --arguments-file <{}>
client.py call-tool --name tigris_list_buckets --arguments-file <{}>
client.py call-tool --name tigris_create_bucket
  {"bucketName":"musemesh-spike-test","isPublic":false}
client.py call-tool --name tigris_get_signed_object_url
  {"bucketName":"musemesh-spike-test","key":"spike-c/hello.txt","operation":"put","expiresIn":3600}
  -> FAILED, no active access keys (exact error in §1.4)
client.py call-tool --name tigris_create_access_key
  {"name":"musemesh-spike-test-put","bucket":"musemesh-spike-test","operation":"put"}
client.py call-tool --name tigris_get_signed_object_url (put) -> OK, 3600 s
curl -X PUT --data-binary @<82 B file> "<signed PUT URL>" -> HTTP 200
client.py call-tool --name tigris_list_objects -> 1 object, 82 B
client.py call-tool --name tigris_get_signed_object_url (get) -> OK, 3600 s
curl "<signed GET URL>" -> HTTP 200, 82 B, SHA-256 identical
client.py call-tool --name tigris_delete_object -> success
client.py call-tool --name tigris_list_objects -> 0 objects
client.py call-tool --name tigris_delete_bucket -> FAILED, "Bucket is not empty"
client.py call-tool --name tigris_list_checkpoints {"bucket":...} -> 0 checkpoints
client.py call-tool --name tigris_get_bucket_details -> server output validation error
client.py call-tool --name tigris_delete_bucket (2nd, after 20 s) -> FAILED, same error
client.py call-tool --name tigris_list_buckets -> 1 bucket left
client.py call-tool --name tigris_list_access_keys -> 1 key left

# Cloudinary
client.py list-tools
client.py call-tool --name get-usage-details --arguments-file <{}>
client.py call-tool --name list-images --arguments-file <{}>
client.py call-tool --name sign-upload
  {"uploads":[{"asset_folder":"musemesh-spike-test","tags":"musemesh-spike-test"}]}
curl -X POST https://api.cloudinary.com/v1_1/<cloud>/image/upload -F file=@<70 B PNG> -F api_key=... -F timestamp=... -F signature=... ...
  -> HTTP 200, public_id "spike-test", 70 B, 1x1 PNG
curl <secure_url> -> HTTP 200, 70 B
curl <secure_url with w_200,h_200,c_fill> -> HTTP 200, 134 B
client.py call-tool --name delete-asset {"request":{"asset_id":"fbe8993c9562cc365cd55f868bd49af1","invalidate":true}}
  -> {"result":"ok"}
client.py call-tool --name list-images -> 10 samples, spike-test gone
```

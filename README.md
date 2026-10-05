# video-worker (FFmpeg → Pinata)

A tiny API that accepts a file upload, transcodes it to MP4 (H.264/AAC) with FFmpeg, then uploads the result to Pinata (IPFS) and returns the CID.

## Endpoints

- `GET /healthz` — health check
- `POST /transcode` — multipart/form-data with a single field named `video`
- `POST /thumbnail` — grab a thumbnail for an existing IPFS CID (see below)
- `POST /image-thumbnail` — downscale an arbitrary image URL (spotmap admin images, see below)
- `GET /progress/:requestId` — **SSE (Server-Sent Events)** for real-time progress streaming
- `GET /logs` — get recent transcode operations (JSON)
- `GET /stats` — get transcoding statistics (JSON)

**Response**
```json
{
  "success": true,
  "data": {
    "cid": "bafy...",
    "gatewayUrl": "https://gateway.pinata.cloud/ipfs/bafy..."
  }
}
```

## Thumbnail-by-CID (`POST /thumbnail`)

For skatehive-api's F3 feature (server-side thumbnails for `/api/v2/videos`):
given a CID that's already pinned but has no thumbnail, grab a frame straight
off the IPFS gateway and pin it, without re-running the full transcode
pipeline.

- Guarded by a **shared secret**, not the CORS/origin gate the other routes
  use — this is a server-to-server call from skatehive-api, not a
  browser/app upload. Send it as `x-thumbnail-secret`.
- Its own capacity of **1**, entirely separate from `/transcode`'s semaphore,
  so a burst of thumbnail requests can never starve (or be starved by) real
  uploads.
- Captures the frame at a fixed **1 second** in (unlike `/transcode`'s
  duration-based capture), with a 60s timeout on the whole fetch+ffmpeg step
  — CIDs the gateway doesn't serve (unpinned, wrong network, etc.) fail fast
  rather than hanging.

**Request**
```bash
curl -X POST https://minivlad.tail83ea3e.ts.net/video/thumbnail \
  -H "content-type: application/json" \
  -H "x-thumbnail-secret: $THUMBNAIL_SHARED_SECRET" \
  -d '{"cid":"bafybeig..."}'
```

**Response**
```json
{ "cid": "bafybeig...", "thumbnailUrl": "https://ipfs.skatehive.app/ipfs/bafy..." }
```

On failure: `401` (bad/missing secret), `400` (missing/malformed `cid`),
`404` (the gateway wouldn't serve this CID, or ffmpeg couldn't grab a frame
from it), `502` (thumbnail generated but the Pinata upload failed), `503`
(another thumbnail job is already in flight — retry shortly).

## Image thumbnails (`POST /image-thumbnail`)

For skatehive-api's spotmap images feature: downscale an image URL to a
small (max ~400px) JPEG and pin it. Used for spot photos that aren't
Hive-hosted — images.hive.blog/files.peakd.com sources are resized for free
via a URL path prefix on the API side and never hit this endpoint; Google My
Maps hostedimage URLs (and similar) come through here instead, since they
accept no size parameter and 400 if you add one.

**Not an open fetch proxy** — `url` must resolve to a host on an allow-list
(`IMAGE_THUMBNAIL_ALLOWED_HOSTS`), checked before any network call:

- Same **shared secret** as `POST /thumbnail` (`x-thumbnail-secret` /
  `THUMBNAIL_SHARED_SECRET`, compared with `crypto.timingSafeEqual`) — one
  secret guards both server-to-server thumbnail endpoints.
- `url` must be **https** and its hostname must be on
  `IMAGE_THUMBNAIL_ALLOWED_HOSTS` (env, comma-separated; default
  `images.hive.blog,files.peakd.com,mymaps.usercontent.google.com,
  lh3.googleusercontent.com,ipfs.skatehive.app`) — an allow-list, not a
  deny-list: anything not on it 400s before a single byte is fetched. To add
  a host, set the same value here and on skatehive-api's
  `IMAGE_THUMBNAIL_ALLOWED_HOSTS` — the two lists must match.
- Its own capacity of **1**, separate from both `/transcode` and
  `/thumbnail`'s semaphores.
- Downloads the source image to a temp file first (unlike `/thumbnail`,
  which hands ffmpeg a known-good Pinata gateway URL directly). No
  redirects are followed (`maxRedirects: 0`) — a 3xx is a failure, since the
  allow-list check only covers the URL that was actually validated. The
  response is capped at `IMAGE_THUMBNAIL_MAX_BYTES` (byte-counted as it
  streams in, not just an axios option — those don't apply to streamed
  responses) and bounded by a hard wall-clock deadline in addition to the
  idle timeout (a slow trickle can't stall the request indefinitely). The
  downloaded file is magic-byte-sniffed (JPEG/PNG/WebP/GIF) before ffmpeg
  ever sees it — an allow-listed host is trusted to be the right *host*, not
  to only ever serve images.
- `ffmpeg -nostdin -f image2 -protocol_whitelist file -i <file> -vf
  "scale=w='min(maxPx,iw)':h='min(maxPx,ih)':force_original_aspect_ratio=decrease" -frames:v 1` to JPEG — the protocol whitelist
  keeps ffmpeg confined to reading the local file we already validated.

**Request**
```bash
curl -X POST https://minivlad.tail83ea3e.ts.net/video/image-thumbnail \
  -H "content-type: application/json" \
  -H "x-thumbnail-secret: $THUMBNAIL_SHARED_SECRET" \
  -d '{"url":"https://mymaps.usercontent.google.com/...","maxPx":400}'
```

**Response**
```json
{ "url": "https://ipfs.skatehive.app/ipfs/bafy..." }
```

On failure: `401` (bad/missing secret), `400` (missing/malformed `url`, not
https, host not on the allow-list, or the downloaded content isn't a
recognized image format), `404` (couldn't download the image, a redirect,
or ffmpeg couldn't read it), `502` (thumbnail generated but the Pinata
upload failed), `503` (another image thumbnail job is already in flight —
retry shortly).

## 🆕 Real-Time Progress Streaming (SSE)

The service now supports **Server-Sent Events (SSE)** for real-time progress updates during transcoding:

### How It Works

1. **Client generates a unique `correlationId`** before uploading
2. **Client opens SSE connection** to `/progress/:correlationId`
3. **Client sends POST to `/transcode`** with the same `correlationId` in form data
4. **Server broadcasts progress** to all connected SSE clients for that request

### Progress Stages

| Stage | Progress Range | Description |
|-------|---------------|-------------|
| `waiting` | 0% | SSE connected, waiting for upload |
| `receiving` | 5% | Server receiving file |
| `transcoding` | 10-80% | FFmpeg processing (based on video duration) |
| `uploading` | 80-100% | Uploading to Pinata IPFS |
| `complete` | 100% | Done! |
| `busy` | 0% | Worker is at capacity; client should retry or use another node |
| `timeout` | 0% | FFmpeg exceeded the configured timeout and was killed |
| `error` | 0% | Something went wrong |

### SSE Client Example

```javascript
// Generate unique ID
const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 6)}`;

// Open SSE connection BEFORE uploading
const eventSource = new EventSource(`https://server/progress/${requestId}`);
eventSource.onmessage = (event) => {
  const { progress, stage } = JSON.parse(event.data);
  console.log(`Progress: ${progress}% - ${stage}`);
  updateProgressBar(progress);
};

// Send upload with correlationId
const formData = new FormData();
formData.append('video', file);
formData.append('correlationId', requestId);
fetch('https://server/transcode', { method: 'POST', body: formData });
```

### Terminal Test

```bash
# Test SSE progress with curl
TEST_ID="test-$(date +%s)" && \
(curl -sN "https://minivlad.tail83ea3e.ts.net/video/progress/$TEST_ID" &) && \
sleep 1 && \
curl -X POST "https://minivlad.tail83ea3e.ts.net/video/transcode" \
  -F "video=@/path/to/video.mov" \
  -F "correlationId=$TEST_ID"
```

## Logging & Monitoring

The service now includes rich structured logging that tracks:
- User/creator information
- File details (name, size)
- Processing duration
- Success/failure status
- Client IP addresses
- IPFS CIDs and gateway URLs

**Logging Features:**
- Maintains last 100 operations in `logs/transcode.log`
- JSON-structured log entries for easy parsing
- Dashboard-friendly endpoints
- Rich console output with emojis and formatting

**Dashboard Integration:**
- `GET /logs?limit=N` - Returns recent operations for dashboard display
- `GET /stats` - Returns aggregated statistics (success rate, avg duration, etc.)
- Designed to work with the Skatehive dashboard monitoring system

## Quickstart (Docker)

```bash
# 1) Clone this project
# 2) Create .env with your PINATA_JWT
cp .env.example .env
# edit .env and paste your Pinata JWT

# 3) Build & run
docker build -t video-worker .

# Development (port 8080):
docker run --env-file .env -p 8080:8080 --name video-worker video-worker

# Production (port 8081 external, 8080 internal):
docker run --env-file .env -p 8081:8080 --name video-worker video-worker

# Or use docker-compose (recommended for production):
docker compose up -d
```

```bash
# 4) Test (adjust port based on deployment)
curl -F "video=@/path/to/input.mov" http://localhost:8080/transcode

# 5) Test logging system (creates mock log entries)
npm run test-logs

# 6) Check logs and stats
curl http://localhost:8080/logs
curl http://localhost:8080/stats
```
```

## Environment

- `PINATA_JWT` (required) — Create in Pinata Dashboard → API Keys (JWT).
- `PINATA_GATEWAY` (optional) — Defaults to `https://gateway.pinata.cloud/ipfs`.
- `MAX_UPLOAD_MB` (optional) — Upload limit, default `512` (set to `200` on Mac Mini M4).
- `MAX_CONCURRENT_JOBS` (optional) — Active `/transcode` jobs allowed at once, default `1`.
- `FFMPEG_TIMEOUT_MS` (optional) — FFmpeg kill timeout, default `600000` (10 minutes).
- `X264_PRESET`, `X264_CRF`, `AAC_BITRATE` — FFmpeg tuning knobs.
- `PORT` (optional) — Internal port, defaults to `8080`.
- `ALLOWED_ORIGINS` (optional) — Comma-separated web origins; defaults to SkateHive, localhost, and Vercel previews.
- `NODE_ENV` — Environment mode (`development` or `production`).
- `THUMBNAIL_SHARED_SECRET` (required for `POST /thumbnail`) — must match skatehive-api's `THUMBNAIL_SHARED_SECRET`. The route rejects every request (401) until this is set.
- `THUMBNAIL_FETCH_TIMEOUT_MS` (optional) — kill timeout for the gateway-fetch + ffmpeg step in `POST /thumbnail`, default `60000` (60s).
- `IMAGE_THUMBNAIL_TIMEOUT_MS` (optional) — timeout for each of the download and ffmpeg steps in `POST /image-thumbnail`, default `60000` (60s). Uses the same `THUMBNAIL_SHARED_SECRET` as `POST /thumbnail`.
- `IMAGE_THUMBNAIL_MAX_BYTES` (optional) — max download size for `POST /image-thumbnail`, default `26214400` (25MB).
- `IMAGE_THUMBNAIL_ALLOWED_HOSTS` (optional) — comma-separated SSRF allow-list for `POST /image-thumbnail`'s `url`, default `images.hive.blog,files.peakd.com,mymaps.usercontent.google.com,lh3.googleusercontent.com,ipfs.skatehive.app`. Must match skatehive-api's `IMAGE_THUMBNAIL_ALLOWED_HOSTS` — set the same value on both, not just one.

## Production Deployment (Mac Mini M4)

**Current Live Configuration:**

- **External URL:** `https://minivlad.tail83ea3e.ts.net/video/transcode`
- **External Port:** `8081`
- **Internal Port:** `8080`
- **Container:** `video-worker`
- **Upload Limit:** `200MB`
- **Network:** Tailscale Funnel (publicly accessible)

**Port Mapping:**
```yaml
# docker-compose.yml
ports:
  - "8081:8080"  # Host:Container
```

This means:
- Service listens on port `8080` inside the container
- Accessible on port `8081` from the host (Mac Mini)
- Tailscale Funnel routes `https://minivlad.tail83ea3e.ts.net/video/*` to port `8081`

## Deploy Options

### Option A: Oracle Cloud "Always Free" VM (recommended free worker)
1. Create an Always Free tenancy and launch an **Ampere A1** or **E2 Micro** VM.
2. SSH in and install Docker:
   ```bash
   sudo apt-get update
   sudo apt-get install -y docker.io
   sudo usermod -aG docker $USER && newgrp docker
   ```
3. Copy this repo to the VM (git clone or scp the zip), then:
   ```bash
   docker build -t video-worker .
   docker run -d --restart=unless-stopped --env-file .env -p 80:8080 --name video-worker video-worker
   ```
4. Open port 80 in the instance's VCN security list if needed.

### Option B: Render (free web service)
1. Push this repo to GitHub.
2. In Render, create **New Web Service** from your repo.
3. Use **Docker** build, set environment variables (`PINATA_JWT`, etc.).
4. Choose a **Free** instance. Note: free instances may sleep and have limits.
5. Deploy and use the generated URL for `/transcode`.

## Notes

- This service does a full transcode to ensure device compatibility. If you know your .mov files are already H.264/AAC, you can switch to a fast remux:
  ```bash
  ffmpeg -i input.mov -c copy -movflags +faststart output.mp4
  ```
  (Integrate by changing the ffmpeg args in `server.js`.)

- For heavier workloads, consider running this behind a queue (e.g., Upstash QStash or Redis) and moving uploads to object storage (S3/R2).

## License

MIT

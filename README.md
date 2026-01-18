# video-worker (FFmpeg → Pinata)

A tiny API that accepts a file upload, transcodes it to MP4 (H.264/AAC) with FFmpeg, then uploads the result to Pinata (IPFS) and returns the CID.

## Endpoints

- `GET /healthz` — health check
- `POST /transcode` — multipart/form-data with a single field named `video`
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
- `X264_PRESET`, `X264_CRF`, `AAC_BITRATE` — FFmpeg tuning knobs.
- `PORT` (optional) — Internal port, defaults to `8080`.
- CORS is open to all origins by default.
- `NODE_ENV` — Environment mode (`development` or `production`).

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

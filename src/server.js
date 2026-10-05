import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import morgan from 'morgan';
import axios from 'axios';
import FormData from 'form-data';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import TranscodeLogger from './logger.js';

// Constant-time shared-secret comparison — a plain !== leaks timing
// information proportional to how many leading characters match, letting an
// attacker recover the secret byte-by-byte over enough requests.
function timingSafeEqualSecret(provided, expected) {
  const providedBuf = Buffer.from(String(provided || ''));
  const expectedBuf = Buffer.from(String(expected || ''));
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}


const app = express();
const logger = new TranscodeLogger();

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://skatehive.app,http://localhost:3000,http://localhost:19006,https://*.vercel.app').split(',').map(s => s.trim()).filter(Boolean);
const MOBILE_UPLOAD_TOKEN = process.env.MOBILE_UPLOAD_TOKEN || '';
const MAX_SAFE_SHORT_EDGE = 1080;
const MAX_SAFE_LONG_EDGE = 1920;
const MOBILE_SAFE_SCALE_FILTER = "scale=w='min(iw,1080)':h='min(ih,1920)':force_original_aspect_ratio=decrease,scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2'";

function isOriginAllowed(origin) {
  return ALLOWED_ORIGINS.some(allowed => {
    if (!allowed.includes('*')) return origin === allowed;
    // Wildcard support: https://*.vercel.app matches https://foo.vercel.app
    const [prefix, suffix] = allowed.split('*');
    return origin.startsWith(prefix) && origin.endsWith(suffix);
  });
}

function getRequestAccess(req) {
  const origin = req.get('Origin') || '';
  const mobileToken = req.get('X-Skatehive-Upload-Key') || '';
  const clientType = req.get('X-Skatehive-Client') || '';
  const hasAllowedOrigin = !!origin && isOriginAllowed(origin);
  const isMobileTokenValid = !!MOBILE_UPLOAD_TOKEN && mobileToken === MOBILE_UPLOAD_TOKEN;
  const isOriginlessRequest = !origin; // native mobile / server-to-server often send no Origin
  const allowed = hasAllowedOrigin || isMobileTokenValid || isOriginlessRequest;
  return { allowed, origin, hasAllowedOrigin, isMobileTokenValid, isOriginlessRequest, clientType };
}

function isMobileSafeResolution(width, height) {
  const shortEdge = Math.min(Number(width) || 0, Number(height) || 0);
  const longEdge = Math.max(Number(width) || 0, Number(height) || 0);
  return shortEdge <= MAX_SAFE_SHORT_EDGE && longEdge <= MAX_SAFE_LONG_EDGE;
}

function hasFastStart(inputPath) {
  try {
    const fd = fs.openSync(inputPath, 'r');
    const buffer = Buffer.alloc(Math.min(1024 * 1024, fs.statSync(inputPath).size));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const header = buffer.toString('latin1');
    const moovIndex = header.indexOf('moov');
    const mdatIndex = header.indexOf('mdat');
    return moovIndex !== -1 && (mdatIndex === -1 || moovIndex < mdatIndex);
  } catch {
    return false;
  }
}

/**
 * Check if video is web/mobile optimized (H.264/AAC-LC, faststart, yuv420p, safe resolution)
 * Returns { optimized: boolean, reason?: string, videoInfo?: object }
 */
async function checkWebOptimized(inputPath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      inputPath
    ]);

    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        return resolve({ optimized: false, reason: 'ffprobe failed' });
      }

      try {
        const info = JSON.parse(stdout);
        const videoStream = info.streams.find(s => s.codec_type === 'video');
        const audioStream = info.streams.find(s => s.codec_type === 'audio');

        if (!videoStream || videoStream.codec_name !== 'h264') {
          return resolve({ optimized: false, reason: `video codec: ${videoStream?.codec_name || 'none'}` });
        }

        if (audioStream && audioStream.codec_name !== 'aac') {
          return resolve({ optimized: false, reason: `audio codec: ${audioStream.codec_name}` });
        }

        if (audioStream && audioStream.profile && audioStream.profile !== 'LC') {
          return resolve({ optimized: false, reason: `audio profile: ${audioStream.profile}` });
        }

        if (!isMobileSafeResolution(videoStream.width, videoStream.height)) {
          return resolve({ optimized: false, reason: `resolution too high: ${videoStream.width}x${videoStream.height}` });
        }

        if (!hasFastStart(inputPath)) {
          return resolve({ optimized: false, reason: 'moov atom is not faststart' });
        }

        // yuv420p (8-bit 4:2:0) is required for universal mobile hardware decode.
        // 10-bit formats (yuv420p10le, yuv422p10le, etc.) look like valid H.264 but
        // fail on most mobile decoders.
        const pixFmt = videoStream.pix_fmt;
        if (pixFmt && pixFmt !== 'yuv420p') {
          return resolve({ optimized: false, reason: `pixel format: ${pixFmt}` });
        }

        resolve({
          optimized: true,
          videoInfo: {
            codec: videoStream.codec_name,
            resolution: `${videoStream.width}x${videoStream.height}`,
            duration: parseFloat(info.format.duration),
            bitrate: parseInt(info.format.bit_rate)
          }
        });
      } catch (err) {
        resolve({ optimized: false, reason: 'parse error' });
      }
    });
  });
}

// Store active transcoding progress for SSE clients
const activeJobs = new Map(); // requestId -> { progress, stage, clients: Set<Response> }
const activeProcessingJobs = new Map(); // requestId -> { startedAt, filename, sourceApp }
const MAX_CONCURRENT_JOBS = Number.parseInt(process.env.MAX_CONCURRENT_JOBS || process.env.MAX_CONCURRENT_TRANSCODES || '1', 10);
const FFMPEG_TIMEOUT_MS = Number.parseInt(process.env.FFMPEG_TIMEOUT_MS || String(10 * 60 * 1000), 10);

// F3: thumbnail-by-CID jobs get their own capacity of 1, entirely separate
// from activeProcessingJobs, so a burst of thumbnail requests can never
// starve (or be starved by) real /transcode uploads.
const activeThumbnailJobs = new Set(); // cid -> in progress

// Spotmap images: image-thumbnail jobs get their own capacity of 1 too,
// separate from both /transcode and /thumbnail — a burst of spotmap admin
// edits (or the backfill script) can't starve or be starved by either.
const activeImageThumbnailJobs = new Set(); // source url -> in progress

function getCapacity() {
  return {
    active: activeProcessingJobs.size,
    max: Number.isFinite(MAX_CONCURRENT_JOBS) && MAX_CONCURRENT_JOBS > 0 ? MAX_CONCURRENT_JOBS : 1,
    available: Math.max(0, (Number.isFinite(MAX_CONCURRENT_JOBS) && MAX_CONCURRENT_JOBS > 0 ? MAX_CONCURRENT_JOBS : 1) - activeProcessingJobs.size),
    jobs: [...activeProcessingJobs.entries()].map(([id, job]) => ({
      id,
      filename: job.filename,
      sourceApp: job.sourceApp,
      elapsedMs: Date.now() - job.startedAt
    }))
  };
}

// Restrictive CORS: allow Skatehive web origins, native/mobile token, and originless app/server calls
app.use((req, res, next) => {
  const access = getRequestAccess(req);

  if (access.hasAllowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', access.origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Requested-With,X-Skatehive-Client,X-Skatehive-Platform,X-Skatehive-App-Version,X-Skatehive-Upload-Key');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return access.allowed ? res.sendStatus(204) : res.status(403).json({ ok: false, error: 'Origin not allowed' });
  }

  req.skatehiveAccess = access;
  next();
});

// Enhanced logging middleware for debugging
app.use((req, res, next) => {
  const startTime = Date.now();
  const clientIP = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
  const userAgent = req.get('User-Agent') || 'unknown';
  const origin = req.get('Origin') || req.get('Referer') || 'direct';

  console.log(`🌐 [${new Date().toISOString()}] ${req.method} ${req.path} - Client: ${clientIP} - Origin: ${origin}`);

  // Log request details for transcode operations
  if (req.path === '/transcode') {
    console.log(`📊 TRANSCODE REQUEST START:`);
    console.log(`   📍 Client IP: ${clientIP}`);
    console.log(`   🌍 Origin: ${origin}`);
    console.log(`   🖥️  User Agent: ${userAgent.substring(0, 100)}`);
    console.log(`   ⏰ Start Time: ${new Date().toISOString()}`);
  }

  // Track response time
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    if (req.path === '/transcode') {
      console.log(`✅ TRANSCODE REQUEST COMPLETE - ${res.statusCode} - ${duration}ms`);
    }
  });

  next();
});

const PORT = process.env.PORT || 8080;
const PINATA_JWT = process.env.PINATA_JWT;
const PINATA_GATEWAY = process.env.PINATA_GATEWAY || 'https://ipfs.skatehive.app/ipfs';
const PINATA_GROUP_VIDEOS = process.env.PINATA_GROUP_VIDEOS || null;
// F3 (server-side thumbnails): shared secret guarding POST /thumbnail. The
// caller (skatehive-api) must send the same value as x-thumbnail-secret.
const THUMBNAIL_SHARED_SECRET = process.env.THUMBNAIL_SHARED_SECRET || '';
const THUMBNAIL_FETCH_TIMEOUT_MS = Number.parseInt(process.env.THUMBNAIL_FETCH_TIMEOUT_MS || '60000', 10);
// Spotmap images: same shared secret as POST /thumbnail (THUMBNAIL_SHARED_SECRET) —
// one secret guards both server-to-server thumbnail endpoints.
const IMAGE_THUMBNAIL_TIMEOUT_MS = Number.parseInt(process.env.IMAGE_THUMBNAIL_TIMEOUT_MS || '60000', 10);
// A non-numeric value parses to NaN, and `received > NaN` is always false —
// the download cap would silently vanish. Fall back to 25 MB instead.
const IMAGE_THUMBNAIL_MAX_BYTES = (() => {
  const n = Number.parseInt(process.env.IMAGE_THUMBNAIL_MAX_BYTES || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 25 * 1024 * 1024;
})();
// SSRF mitigation: an allow-list, not a deny-list — reject every host that
// isn't one of these before making any network call, rather than trying to
// enumerate every private/internal address to block. Mirrors
// IMAGE_THUMBNAIL_ALLOWED_HOSTS on skatehive-api (src/lib/spotmap-thumbnails.ts);
// keep the two in sync by setting the SAME value in both services' env, not
// just one. To extend: add the host here (comma-separated) and there.
const IMAGE_THUMBNAIL_ALLOWED_HOSTS = (
  process.env.IMAGE_THUMBNAIL_ALLOWED_HOSTS ||
  'images.hive.blog,files.peakd.com,mymaps.usercontent.google.com,lh3.googleusercontent.com,ipfs.skatehive.app'
).split(',').map(h => h.trim().toLowerCase()).filter(Boolean);

function isAllowedImageThumbnailUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return IMAGE_THUMBNAIL_ALLOWED_HOSTS.includes(parsed.hostname.toLowerCase());
}

// JPEG/PNG/WebP/GIF magic-byte signatures. Checked against the downloaded
// file before it ever reaches ffmpeg — an allow-listed host is trusted to be
// the right HOST, not to only ever serve images (or to not have been
// compromised), so the content itself still gets verified.
function sniffImageMagicBytes(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    const bytesRead = fs.readSync(fd, buf, 0, 12, 0);
    if (bytesRead >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true; // JPEG
    if (bytesRead >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true; // PNG
    if (bytesRead >= 4 && buf.toString('ascii', 0, 4) === 'GIF8') return true; // GIF
    if (bytesRead >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true; // WebP
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

if (!THUMBNAIL_SHARED_SECRET) {
  console.warn('⚠️  THUMBNAIL_SHARED_SECRET is not set — POST /thumbnail and POST /image-thumbnail will reject every request.');
}

if (!PINATA_JWT) {
  console.warn('⚠️  PINATA_JWT is not set. Set it in your environment before starting.');
}

// Morgan logging for HTTP requests
app.use(morgan('combined'));

// Helper to detect browser requests
const wantsHtml = (req) => String(req.headers.accept || '').includes('text/html');

// Health check with HTML support for browsers
const sendHealth = (req, res, payload, title) => {
  if (wantsHtml(req)) {
    const html = [
      '<!doctype html>',
      '<html>',
      `  <head><meta charset="utf-8"><title>${title}</title></head>`,
      '  <body style="font-family: system-ui; padding: 2rem; max-width: 600px; margin: 0 auto;">',
      `    <h1 style="color: #32cd32;">🎬 ${title}</h1>`,
      `    <p><strong>Status:</strong> ${payload.ok ? '✅ Healthy' : '❌ Error'}</p>`,
      `    <p><strong>Service:</strong> ${payload.service || 'video-worker'}</p>`,
      `    <p><strong>Timestamp:</strong> ${payload.timestamp}</p>`,
      '  </body>',
      '</html>'
    ].join('\n');
    res.type('html').send(html);
    return;
  }
  res.json(payload);
};

app.get('/', (_req, res) => res.send('🎬 Video Worker - Ready for transcoding!'));
app.head('/', (_req, res) => res.sendStatus(200));
app.get('/healthz', (req, res) => {
  const capacity = getCapacity();
  const payload = {
    ok: true,
    service: 'video-worker',
    timestamp: new Date().toISOString(),
    capacity: {
      active: capacity.active,
      max: capacity.max,
      available: capacity.available
    },
    thumbnailCapacity: {
      active: activeThumbnailJobs.size,
      max: 1,
      available: activeThumbnailJobs.size >= 1 ? 0 : 1
    },
    imageThumbnailCapacity: {
      active: activeImageThumbnailJobs.size,
      max: 1,
      available: activeImageThumbnailJobs.size >= 1 ? 0 : 1
    }
  };
  sendHealth(req, res, payload, 'Video Worker Health');
});

// F3 (server-side thumbnails): given a CID, grab a frame straight off the
// IPFS gateway and pin it. Guarded by a shared secret (not the CORS/origin
// gate above) since this is a server-to-server call from skatehive-api, not
// a browser/app upload. Its own capacity of 1, separate from /transcode.
app.post('/thumbnail', express.json(), async (req, res) => {
  const provided = req.get('x-thumbnail-secret') || '';
  if (!THUMBNAIL_SHARED_SECRET || !timingSafeEqualSecret(provided, THUMBNAIL_SHARED_SECRET)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const cid = String(req.body?.cid || '').trim();
  if (!cid || !/^[a-zA-Z0-9]+$/.test(cid)) {
    return res.status(400).json({ ok: false, error: 'Missing or invalid cid' });
  }

  if (activeThumbnailJobs.size >= 1) {
    return res.status(503).json({ ok: false, error: 'Thumbnail worker busy, try again shortly', cid });
  }

  activeThumbnailJobs.add(cid);
  const startTime = Date.now();
  let thumbPath = null;
  try {
    const gatewayUrl = `${PINATA_GATEWAY.replace(/\/+$/, '')}/${cid}`;
    thumbPath = await generateThumbnail(gatewayUrl, undefined, {
      captureTime: 1,
      timeoutMs: THUMBNAIL_FETCH_TIMEOUT_MS
    });
    if (!thumbPath) {
      console.warn(`⚠️ Thumbnail generation failed for ${cid} (gateway didn't serve it in time, or ffmpeg failed)`);
      return res.status(404).json({ ok: false, error: 'Could not generate a thumbnail for this CID', cid });
    }

    const thumbnailUrl = await uploadThumbnailToPinata(thumbPath, cid);
    thumbPath = null; // uploadThumbnailToPinata always cleans up the file itself, success or failure

    if (!thumbnailUrl) {
      return res.status(502).json({ ok: false, error: 'Thumbnail generated but the Pinata upload failed', cid });
    }

    console.log(`✅ Thumbnail ready for ${cid} in ${Date.now() - startTime}ms`);
    return res.json({ cid, thumbnailUrl });
  } catch (err) {
    console.error(`⚠️ Thumbnail job failed for ${cid}:`, err.message || err);
    return res.status(500).json({ ok: false, error: 'Thumbnail job failed', cid });
  } finally {
    activeThumbnailJobs.delete(cid);
    if (thumbPath) { try { fs.unlinkSync(thumbPath); } catch {} }
  }
});

// Spotmap images: downscale an arbitrary image URL (Google My Maps
// hostedimage URLs mainly — they accept no size parameter and 400 if you add
// one, unlike images.hive.blog, which resizes those for free and never needs
// this endpoint). Same shared-secret auth as POST /thumbnail, own capacity
// of 1, 60s timeout covering both the download and the ffmpeg step.
app.post('/image-thumbnail', express.json(), async (req, res) => {
  const provided = req.get('x-thumbnail-secret') || '';
  if (!THUMBNAIL_SHARED_SECRET || !timingSafeEqualSecret(provided, THUMBNAIL_SHARED_SECRET)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const sourceUrl = String(req.body?.url || '').trim();
  if (!sourceUrl || !isAllowedImageThumbnailUrl(sourceUrl)) {
    // Rejected before any network call — SSRF allow-list, not a deny-list:
    // only https URLs on IMAGE_THUMBNAIL_ALLOWED_HOSTS get past this point.
    return res.status(400).json({ ok: false, error: 'url must be https and on the allowed host list' });
  }
  const requestedMaxPx = Number(req.body?.maxPx);
  const maxPx = Number.isFinite(requestedMaxPx) && requestedMaxPx > 0
    ? Math.min(Math.round(requestedMaxPx), 1000)
    : 400;

  if (activeImageThumbnailJobs.size >= 1) {
    return res.status(503).json({ ok: false, error: 'Image thumbnail worker busy, try again shortly', url: sourceUrl });
  }

  activeImageThumbnailJobs.add(sourceUrl);
  const startTime = Date.now();
  let downloadedPath = null;
  let thumbPath = null;
  try {
    downloadedPath = await downloadToTempFile(sourceUrl, IMAGE_THUMBNAIL_TIMEOUT_MS, IMAGE_THUMBNAIL_MAX_BYTES);
    if (!downloadedPath) {
      console.warn(`⚠️ Image download failed for ${sourceUrl}`);
      return res.status(404).json({ ok: false, error: 'Could not download this image', url: sourceUrl });
    }

    if (!sniffImageMagicBytes(downloadedPath)) {
      console.warn(`⚠️ Downloaded content is not a recognized image format: ${sourceUrl}`);
      return res.status(400).json({ ok: false, error: 'Downloaded content is not a recognized image format', url: sourceUrl });
    }

    thumbPath = await generateImageThumbnail(downloadedPath, maxPx, IMAGE_THUMBNAIL_TIMEOUT_MS);
    if (!thumbPath) {
      console.warn(`⚠️ Image thumbnail generation failed for ${sourceUrl}`);
      return res.status(404).json({ ok: false, error: 'Could not generate a thumbnail for this image', url: sourceUrl });
    }

    const thumbnailUrl = await uploadThumbnailToPinata(thumbPath, 'spotmap');
    thumbPath = null; // uploadThumbnailToPinata always cleans up the file itself, success or failure

    if (!thumbnailUrl) {
      return res.status(502).json({ ok: false, error: 'Thumbnail generated but the Pinata upload failed', url: sourceUrl });
    }

    console.log(`✅ Image thumbnail ready for ${sourceUrl} in ${Date.now() - startTime}ms`);
    return res.json({ url: thumbnailUrl });
  } catch (err) {
    console.error(`⚠️ Image thumbnail job failed for ${sourceUrl}:`, err.message || err);
    return res.status(500).json({ ok: false, error: 'Image thumbnail job failed', url: sourceUrl });
  } finally {
    activeImageThumbnailJobs.delete(sourceUrl);
    if (downloadedPath) { try { fs.unlinkSync(downloadedPath); } catch {} }
    if (thumbPath) { try { fs.unlinkSync(thumbPath); } catch {} }
  }
});

// SSE endpoint for progress streaming
app.get('/progress/:requestId', (req, res) => {
  const { requestId } = req.params;
  
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if ((req.skatehiveAccess || getRequestAccess(req)).hasAllowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', (req.skatehiveAccess || getRequestAccess(req)).origin);
    res.setHeader('Vary', 'Origin');
  }
  res.flushHeaders();

  // Create job entry if doesn't exist
  if (!activeJobs.has(requestId)) {
    activeJobs.set(requestId, { progress: 0, stage: 'waiting', clients: new Set() });
  }
  
  const job = activeJobs.get(requestId);
  job.clients.add(res);
  
  // Send current state immediately
  res.write(`data: ${JSON.stringify({ progress: job.progress, stage: job.stage })}\n\n`);
  
  // Cleanup on close
  req.on('close', () => {
    job.clients.delete(res);
    if (job.clients.size === 0 && job.stage === 'complete') {
      activeJobs.delete(requestId);
    }
  });
});

// Helper to broadcast progress to all SSE clients for a job
function broadcastProgress(requestId, progress, stage) {
  const job = activeJobs.get(requestId);
  if (!job) return;
  
  job.progress = progress;
  job.stage = stage;
  
  const message = JSON.stringify({ progress, stage });
  for (const client of job.clients) {
    client.write(`data: ${message}\n\n`);
  }
}

function closeJobLater(requestId, delayMs = 5000) {
  setTimeout(() => {
    if (activeJobs.has(requestId)) {
      const job = activeJobs.get(requestId);
      job?.clients?.forEach(client => {
        try { client.end(); } catch { }
      });
      activeJobs.delete(requestId);
    }
  }, delayMs);
}

// Dashboard endpoints
app.get('/logs', (_req, res) => {
  const limit = parseInt(_req.query.limit) || 10;
  const logs = logger.getLogsForDashboard(limit);
  res.json({ logs, stats: logger.getStats() });
});

app.get('/stats', (_req, res) => {
  res.json({ ...logger.getStats(), capacity: getCapacity() });
});

// Configure multer to write incoming file to the OS temp dir
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
  }),
  limits: {
    fileSize: (process.env.MAX_UPLOAD_MB ? parseInt(process.env.MAX_UPLOAD_MB, 10) : 512) * 1024 * 1024 // default 512MB
  }
});

function parseDeviceInfo(userAgent, providedDeviceInfo) {
  if (providedDeviceInfo) return providedDeviceInfo;

  // Parse device type from User-Agent
  const ua = userAgent.toLowerCase();
  let deviceType = 'desktop';
  let os = 'unknown';
  let browser = 'unknown';

  // Device type detection
  if (ua.includes('mobile') || ua.includes('android')) deviceType = 'mobile';
  else if (ua.includes('tablet') || ua.includes('ipad')) deviceType = 'tablet';

  // OS detection
  if (ua.includes('windows')) os = 'windows';
  else if (ua.includes('mac')) os = 'macos';
  else if (ua.includes('linux')) os = 'linux';
  else if (ua.includes('android')) os = 'android';
  else if (ua.includes('iphone') || ua.includes('ipad')) os = 'ios';

  // Browser detection
  if (ua.includes('chrome') && !ua.includes('edg')) browser = 'chrome';
  else if (ua.includes('firefox')) browser = 'firefox';
  else if (ua.includes('safari') && !ua.includes('chrome')) browser = 'safari';
  else if (ua.includes('edg')) browser = 'edge';

  return `${deviceType}/${os}/${browser}`;
}

/**
 * Generate a JPEG thumbnail from a video file using FFmpeg.
 * Captures a frame at 10% into the video (max 5s) and scales to max 640px.
 * Returns the path to the thumbnail file, or null on failure.
 */
async function generateThumbnail(videoPath, videoDuration, opts = {}) {
  const thumbPath = path.join(os.tmpdir(), `thumb-${uuidv4()}.jpg`);
  // Capture at 10% of duration, capped at 5s, minimum 0.5s — unless the
  // caller (F3's /thumbnail route, which has no duration up front) passes a
  // fixed captureTime instead.
  const captureTime = opts.captureTime != null
    ? opts.captureTime
    : Math.min(Math.max((videoDuration || 2) * 0.1, 0.5), 5);

  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-ss', String(captureTime),
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', 'scale=min(iw\\,640):min(ih\\,640):force_original_aspect_ratio=decrease',
      '-q:v', '4', // JPEG quality (2-31, lower = better)
      thumbPath
    ]);

    let timedOut = false;
    const timeoutId = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;

    proc.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (!timedOut && code === 0 && fs.existsSync(thumbPath)) {
        resolve(thumbPath);
      } else {
        try { fs.unlinkSync(thumbPath); } catch {}
        resolve(null);
      }
    });

    proc.on('error', () => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve(null);
    });
  });
}

/**
 * Upload a thumbnail to Pinata and return its gateway URL.
 * Returns null if upload fails.
 */
async function uploadThumbnailToPinata(thumbPath, creator) {
  if (!PINATA_JWT || !thumbPath) return null;

  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(thumbPath), {
      filename: `${creator}-thumb-${Date.now()}.jpg`,
      contentType: 'image/jpeg'
    });

    const metadata = {
      name: `${creator}-thumbnail.jpg`,
      keyvalues: {
        creator,
        source: 'video-worker',
        fileType: 'thumbnail',
        uploadDate: new Date().toISOString()
      }
    };
    form.append('pinataMetadata', JSON.stringify(metadata));
    form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

    const resp = await axios.post(
      'https://api.pinata.cloud/pinning/pinFileToIPFS',
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${PINATA_JWT}`
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 30000
      }
    );

    const { IpfsHash: cid } = resp.data;
    return `${PINATA_GATEWAY.replace(/\/+$/, '')}/${cid}`;
  } catch (err) {
    console.warn(`⚠️ Thumbnail upload failed: ${err.message}`);
    return null;
  } finally {
    // Cleanup thumbnail file
    try { fs.unlinkSync(thumbPath); } catch {}
  }
}

/**
 * Download an arbitrary (allow-listed) image URL to a temp file. Used by
 * POST /image-thumbnail for sources ffmpeg can't be trusted to fetch
 * directly (Google My Maps hostedimage URLs etc. — unlike POST /thumbnail,
 * which hands ffmpeg a known-good Pinata gateway URL straight up).
 * Returns the temp file path, or null on any failure.
 *
 * Two independent size/time guards beyond axios's own options, since axios
 * does NOT enforce maxContentLength/maxBodyLength for responseType:'stream'
 * (those only apply when axios buffers the response itself):
 *  - byte count is tallied on every 'data' chunk and the stream is destroyed
 *    the moment it crosses the cap, instead of trusting the response to stop.
 *  - a wall-clock AbortController deadline fires regardless of ongoing
 *    trickle activity, in addition to axios's `timeout` (which is closer to
 *    an idle/inactivity timeout) — a slow-loris style drip feed could
 *    otherwise stall the request indefinitely without ever going idle.
 * maxRedirects: 0 — a redirect is treated as a failure, not followed; the
 * allow-list check happened against the ORIGINAL url, and a redirect target
 * could point anywhere.
 */
async function downloadToTempFile(url, timeoutMs, maxBytes) {
  const destPath = path.join(os.tmpdir(), `spot-img-${uuidv4()}`);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: timeoutMs,
      maxRedirects: 0,
      signal: controller.signal,
      headers: { 'user-agent': 'skatehive-transcoder-image-thumb/1.0' }
    });
    let received = 0;
    let overLimit = false;
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(destPath);
      response.data.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBytes && !overLimit) {
          overLimit = true;
          response.data.destroy(new Error('Response exceeds max allowed size'));
          writer.destroy();
        }
      });
      response.data.pipe(writer);
      writer.on('finish', () => { if (!overLimit) resolve(); });
      writer.on('error', reject);
      response.data.on('error', reject);
    });
    return destPath;
  } catch (err) {
    try { fs.unlinkSync(destPath); } catch {}
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Downscale a still image so neither side exceeds maxPx (aspect
 * preserved, never upscaled) and re-encode as JPEG — one frame, no seeking (unlike
 * generateThumbnail, which is video-specific: -ss + duration-based capture
 * time). Returns the path to the thumbnail file, or null on failure/timeout.
 *
 * -nostdin: never wait on stdin (this runs unattended). -f image2
 * -protocol_whitelist file: input is a local file we just downloaded and
 * magic-byte-sniffed ourselves — this forbids ffmpeg from being tricked into
 * opening anything else (a URL, a pipe) even if imagePath were ever
 * attacker-influenced.
 */
async function generateImageThumbnail(imagePath, maxPx, timeoutMs) {
  const thumbPath = path.join(os.tmpdir(), `img-thumb-${uuidv4()}.jpg`);

  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-nostdin',
      '-f', 'image2',
      '-protocol_whitelist', 'file',
      '-i', imagePath,
      // Bound BOTH sides: width-only let a portrait photo come out 400x1066.
      '-vf', `scale=w='min(${maxPx},iw)':h='min(${maxPx},ih)':force_original_aspect_ratio=decrease`,
      '-frames:v', '1',
      '-q:v', '4',
      thumbPath
    ]);

    let timedOut = false;
    const timeoutId = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill('SIGKILL');
        }, timeoutMs)
      : null;

    proc.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (!timedOut && code === 0 && fs.existsSync(thumbPath)) {
        resolve(thumbPath);
      } else {
        try { fs.unlinkSync(thumbPath); } catch {}
        resolve(null);
      }
    });

    proc.on('error', () => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve(null);
    });
  });
}

// Get video duration using ffprobe
function getVideoDuration(inputPath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath
    ]);
    
    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.on('close', () => {
      const duration = parseFloat(output.trim());
      resolve(isNaN(duration) ? 0 : duration);
    });
  });
}

// Parse FFmpeg time string to seconds
function timeToSeconds(timeStr) {
  const parts = timeStr.split(':');
  return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
}

function runFfmpeg(args, requestId = 'unknown', totalDuration = 0) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`⏱️ [FFMPEG-TIMEOUT] ID: ${requestId} | Timeout: ${FFMPEG_TIMEOUT_MS}ms`);
      broadcastProgress(requestId, 0, 'timeout');
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        if (!settled) {
          try { proc.kill('SIGKILL'); } catch {}
        }
      }, 5000);
    }, FFMPEG_TIMEOUT_MS);

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      // Log progress if available
      const progressMatch = d.toString().match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
      if (progressMatch) {
        const timeElapsed = Date.now() - startTime;
        const currentTime = timeToSeconds(progressMatch[1]);
        
        // Calculate percentage (0-80% for transcoding, 80-100% for upload)
        let percent = 0;
        if (totalDuration > 0) {
          percent = Math.min(80, Math.round((currentTime / totalDuration) * 80));
        }
        
        // Broadcast to SSE clients
        broadcastProgress(requestId, percent, 'transcoding');
        
        logger.logFFmpegProgress({
          id: requestId,
          progress: progressMatch[1],
          percent,
          timeElapsed
        });
      }
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      if (timedOut) {
        const error = new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms`);
        error.code = 'FFMPEG_TIMEOUT';
        console.error(`❌ [FFMPEG-TIMEOUT] ID: ${requestId} | Duration: ${duration}ms | Error: ${stderr.slice(-400)}`);
        settle(reject, error);
        return;
      }

      if (code === 0) {
        console.log(`✅ [FFMPEG-SUCCESS] ID: ${requestId} | Duration: ${duration}ms`);
        broadcastProgress(requestId, 80, 'uploading'); // Transcoding done, now uploading
        settle(resolve, { ok: true });
      } else {
        console.error(`❌ [FFMPEG-ERROR] ID: ${requestId} | Code: ${code} | Duration: ${duration}ms | Error: ${stderr.slice(-400)}`);
        broadcastProgress(requestId, 0, 'error');
        settle(reject, new Error(`ffmpeg exited with ${code}: ${stderr.slice(-4000)}`));
      }
    });

    proc.on('error', (error) => {
      broadcastProgress(requestId, 0, 'error');
      settle(reject, error);
    });
  });
}

// POST /transcode  (multipart form fields: video [required], creator [optional], thumbnail [optional], platform [optional], deviceInfo [optional])
app.post('/transcode', upload.single('video'), async (req, res) => {
  const access = req.skatehiveAccess || getRequestAccess(req);
  if (!access.allowed) {
    return res.status(403).json({ ok: false, error: 'Request origin not allowed' });
  }

  const internalId = uuidv4().substring(0, 8); // Short ID for internal logging
  const startTime = Date.now();
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  const userAgent = req.get('User-Agent') || 'unknown';
  const origin = req.get('Origin') || req.get('Referer') || 'direct';

  // Extract rich user information from form data
  // ALL FIELDS ARE OPTIONAL for backward compatibility with older app versions
  // req.body may be undefined if multer didn't parse the request (e.g. wrong content-type)
  const body = req.body || {};
  
  // Core fields (with fallbacks)
  const creator = body.creator || body.user || 'anonymous';
  
  // SOURCE APP TRACKING - Critical for analytics
  // Values: 'webapp' | 'mobile' | 'unknown'
  // Mobile app sends 'mobile', webapp sends 'webapp'
  const sourceApp = body.source_app || body.sourceApp || 'unknown';
  
  // App version tracking (optional)
  const appVersion = body.app_version || body.appVersion || '';
  
  // Platform details (optional)
  const platform = body.platform || 'unknown';
  const deviceInfo = body.deviceInfo || '';
  const browserInfo = body.browserInfo || '';
  const userHP = body.userHP || null;
  
  // Use client's correlationId for SSE progress (so client can subscribe before request)
  // Fall back to internal ID if not provided
  const correlationId = body.correlationId || null;
  const requestId = correlationId || internalId; // Use correlationId for SSE progress!
  const viewport = body.viewport || null;
  const connectionType = body.connectionType || null;
  
  // Parse device info from User-Agent if not provided
  const deviceDetails = parseDeviceInfo(userAgent, deviceInfo);
  
  console.log(`🔗 Request ID for SSE: ${requestId} (correlationId: ${correlationId || 'none'})`);

  // Log transcode start
  logger.logTranscodeStart({
    id: requestId,
    user: creator,
    sourceApp,
    appVersion,
    filename: req.file?.originalname || 'unknown',
    fileSize: req.file?.size || 0,
    clientIP,
    userAgent,
    origin,
    platform,
    deviceInfo: deviceDetails,
    browserInfo,
    userHP,
    correlationId,
    viewport,
    connectionType
  });

  if (!req.file) {
    const duration = Date.now() - startTime;
    logger.logTranscodeError({
      id: requestId,
      user: creator,
      filename: 'unknown',
      error: 'No file uploaded',
      duration,
      clientIP
    });
    return res.status(400).json({ error: 'No file uploaded. Send multipart/form-data with field "video".' });
  }

  const inputPath = req.file.path;
  const fileName = req.file.originalname;
  const fileSize = req.file.size;
  let outputPath = null;
  let needsTranscoding = false;
  let videoDuration = 0;
  let processingSlotAcquired = false;

  // Initialize job tracking for SSE - PRESERVE existing clients if SSE connected first!
  const existingJob = activeJobs.get(requestId);
  const clients = existingJob?.clients || new Set();
  activeJobs.set(requestId, { progress: 0, stage: 'starting', clients });
  console.log(`📡 SSE clients for ${requestId}: ${clients.size}`);
  broadcastProgress(requestId, 5, 'receiving');

  const capacity = getCapacity();
  if (capacity.active >= capacity.max) {
    const duration = Date.now() - startTime;
    const error = `Worker busy: ${capacity.active}/${capacity.max} processing jobs active`;
    console.warn(`🚦 [BUSY] ID: ${requestId} | ${error}`);
    broadcastProgress(requestId, 0, 'busy');
    logger.logTranscodeError({
      id: requestId,
      user: creator,
      filename: req.file?.originalname || 'unknown',
      error,
      duration,
      clientIP
    });
    try { fs.unlinkSync(inputPath); } catch {}
    closeJobLater(requestId);
    return res.status(503).json({
      error,
      requestId,
      retryAfterSeconds: 30,
      capacity: {
        active: capacity.active,
        max: capacity.max,
        available: capacity.available
      },
      timestamp: new Date().toISOString()
    });
  }

  activeProcessingJobs.set(requestId, {
    startedAt: Date.now(),
    filename: fileName,
    sourceApp
  });
  processingSlotAcquired = true;

  try {
    // Check if file is already web-optimized
    console.log(`🔍 Checking if ${fileName} is web-optimized...`);
    const validation = await checkWebOptimized(inputPath);

    if (validation.optimized) {
      console.log(`✅ File is already optimized: ${JSON.stringify(validation.videoInfo)}`);
      console.log(`⚡ Skipping transcoding, uploading directly to IPFS`);
      broadcastProgress(requestId, 50, 'optimized');
      outputPath = inputPath; // Use original file
      needsTranscoding = false;
      videoDuration = validation.videoInfo?.duration || 0;
    } else {
      console.log(`⚠️  File needs transcoding: ${validation.reason}`);
      needsTranscoding = true;
      broadcastProgress(requestId, 10, 'transcoding');

      const outName = `${uuidv4()}.mp4`;
      outputPath = path.join(os.tmpdir(), outName);

      // Get video duration for progress calculation
      videoDuration = await getVideoDuration(inputPath);
      console.log(`📏 Video duration: ${videoDuration}s`);

      // Adaptive CRF based on duration and file size
      let crf = process.env.X264_CRF || '22';
      const durationMin = videoDuration / 60;
      const sizeMB = fileSize / (1024 * 1024);

      if (durationMin > 5 || sizeMB > 50) {
        crf = '24'; // More compression for long/large videos
        console.log(`📉 Using CRF 24 for large video (${durationMin.toFixed(1)}min, ${sizeMB.toFixed(1)}MB)`);
      } else if (durationMin < 1) {
        crf = '20'; // Better quality for short clips
        console.log(`📈 Using CRF 20 for short video (${durationMin.toFixed(1)}min)`);
      }

      // Build FFmpeg args with optimizations
      const ffArgs = [
        '-y',
        '-i', inputPath,
        '-c:v', 'libx264',
        '-preset', process.env.X264_PRESET || 'medium',
        '-crf', crf,
        '-vf', MOBILE_SAFE_SCALE_FILTER,
        '-maxrate', '5M',
        '-bufsize', '10M',
        '-pix_fmt', 'yuv420p', // 8-bit 4:2:0 — required for universal mobile hardware decode
        '-profile:v', 'high',
        '-level:v', '4.1',
        '-c:a', 'aac',
        '-profile:a', 'aac_low',
        '-b:a', process.env.AAC_BITRATE || '128k',
        '-ac', '2',
        '-ar', '44100',
        '-movflags', '+faststart',
        outputPath
      ];

      await runFfmpeg(ffArgs, requestId, videoDuration);

      const outputValidation = await checkWebOptimized(outputPath);
      if (!outputValidation.optimized) {
        throw new Error(`Transcoded output failed mobile-safe validation: ${outputValidation.reason}`);
      }
      console.log(`✅ Mobile-safe output validated: ${JSON.stringify(outputValidation.videoInfo)}`);
    }

    broadcastProgress(requestId, 80, 'uploading');

    // Upload to Pinata
    if (!PINATA_JWT) {
      throw new Error('PINATA_JWT not configured on server');
    }

    // Resolve thumbnail: use client-provided one, or auto-generate from video
    const thumbnailRaw = (req.body?.thumbnail ?? req.body?.thumbnailUrl ?? '').toString().trim();
    let thumbnail = thumbnailRaw ? thumbnailRaw.slice(0, 2048) : '';

    if (!thumbnail) {
      // Auto-generate thumbnail from the video file
      console.log(`🖼️ Auto-generating thumbnail for ${requestId}...`);
      const thumbPath = await generateThumbnail(outputPath, videoDuration);
      if (thumbPath) {
        const thumbUrl = await uploadThumbnailToPinata(thumbPath, creator);
        if (thumbUrl) {
          thumbnail = thumbUrl;
          console.log(`✅ Thumbnail generated and uploaded: ${thumbUrl}`);
        }
      }
    }

    const uploadName = needsTranscoding ? path.basename(outputPath) : fileName;
    const form = new FormData();
    form.append('file', fs.createReadStream(outputPath), { filename: uploadName, contentType: 'video/mp4' });

    // Pinata metadata with rich keyvalues (standardized schema matching webapp)
    // PINATA HARD LIMIT: max 10 keyvalues — keep to 9 for safety
    const uploadDate = new Date().toISOString();
    const keyvalues = {
      creator,
      source: 'video-worker',
      uploadDate,
      transcoded: needsTranscoding ? 'true' : 'passthrough',
      originalFileName: req.file.originalname,
      videoDuration: videoDuration ? videoDuration.toString() : 'unknown',
      ...(sourceApp && { sourceApp }),
      ...(platform && { platform }),
      ...(thumbnail && { thumbnailUrl: thumbnail })
    };
    // Enforce max 9 keyvalues (Pinata rejects >10, be safe)
    const trimmedKeyvalues = Object.fromEntries(Object.entries(keyvalues).slice(0, 9));
    const metadata = {
      name: `${creator}-${uploadDate}.mp4`,
      keyvalues: trimmedKeyvalues
    };
    form.append('pinataMetadata', JSON.stringify(metadata));

    const options = {
      cidVersion: 1,
      ...(PINATA_GROUP_VIDEOS && { groupId: PINATA_GROUP_VIDEOS })
    };
    form.append('pinataOptions', JSON.stringify(options));

    broadcastProgress(requestId, 85, 'uploading');

    // Upload to Pinata with retry logic (Pinata can return transient 400s)
    let resp;
    const MAX_PINATA_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_PINATA_RETRIES; attempt++) {
      try {
        // Rebuild form on retry (stream already consumed on previous attempt)
        const retryForm = new FormData();
        retryForm.append('file', fs.createReadStream(outputPath), { filename: uploadName, contentType: 'video/mp4' });
        retryForm.append('pinataMetadata', JSON.stringify(metadata));
        retryForm.append('pinataOptions', JSON.stringify(options));

        resp = await axios.post(
          'https://api.pinata.cloud/pinning/pinFileToIPFS',
          retryForm,
          {
            headers: {
              ...retryForm.getHeaders(),
              Authorization: `Bearer ${PINATA_JWT}`
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 300000, // 5 min per attempt — prevent silent hang
            onUploadProgress: (progressEvent) => {
              if (progressEvent.total) {
                const uploadPercent = Math.round((progressEvent.loaded / progressEvent.total) * 15);
                broadcastProgress(requestId, 85 + uploadPercent, 'uploading');
              }
            }
          }
        );
        break; // success
      } catch (pinataErr) {
        const status = pinataErr.response?.status;
        const detail = JSON.stringify(pinataErr.response?.data || pinataErr.message);
        console.error(`❌ [PINATA] Attempt ${attempt}/${MAX_PINATA_RETRIES} failed — HTTP ${status}: ${detail}`);
        if (attempt === MAX_PINATA_RETRIES) throw pinataErr;
        // Wait before retrying: 2s, 4s
        await new Promise(r => setTimeout(r, attempt * 2000));
        broadcastProgress(requestId, 85, `uploading_retry_${attempt}`);
      }
    }

    const { IpfsHash: cid } = resp.data;
    const gatewayUrl = `${PINATA_GATEWAY.replace(/\/+$/, '')}/${cid}`;
    const totalDuration = Date.now() - startTime;

    // Broadcast completion
    broadcastProgress(requestId, 100, 'complete');

    // Log successful completion
    logger.logTranscodeComplete({
      id: requestId,
      user: creator,
      filename: req.file.originalname,
      cid,
      gatewayUrl,
      duration: totalDuration,
      clientIP
    });

    res.status(200).json({
      cid,
      gatewayUrl,
      requestId,
      duration: totalDuration,
      creator,
      sourceApp,
      timestamp: new Date().toISOString(),
      ...(thumbnail && { thumbnailUrl: thumbnail })
    });

  } catch (err) {
    const totalDuration = Date.now() - startTime;

    // Broadcast error to SSE clients
    broadcastProgress(requestId, 0, 'error');

    // Enhanced error logging for debugging Pinata issues
    const pinataDetail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`❌ [PINATA-ERROR] HTTP ${err.response?.status || 'N/A'}: ${pinataDetail}`);

    // Log error
    logger.logTranscodeError({
      id: requestId,
      user: creator,
      filename: req.file?.originalname || 'unknown',
      error: err.message || err,
      duration: totalDuration,
      clientIP
    });

    const statusCode = err.code === 'FFMPEG_TIMEOUT' ? 504 : 500;
    res.status(statusCode).json({
      error: err.message || 'Transcode failed',
      requestId,
      duration: totalDuration,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (processingSlotAcquired) {
      activeProcessingJobs.delete(requestId);
    }

    // Cleanup - only delete transcoded file if different from input
    try { fs.unlinkSync(inputPath); } catch { }
    if (needsTranscoding && outputPath && outputPath !== inputPath) {
      try { fs.unlinkSync(outputPath); } catch { }
    }

    // Clean up job tracking after a delay (let SSE clients receive final state)
    closeJobLater(requestId);
  }
});

app.listen(PORT, () => {
  console.log(`🎬 Video worker listening on :${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/healthz`);
  console.log(`🎯 Transcode endpoint: http://localhost:${PORT}/transcode`);
  console.log(`🌊 Progress SSE: http://localhost:${PORT}/progress/:requestId`);
  console.log(`📊 Logs endpoint: http://localhost:${PORT}/logs`);
  console.log(`📈 Stats endpoint: http://localhost:${PORT}/stats`);
  console.log(`📋 Dashboard monitoring enabled with structured logging`);
  console.log(`📁 Logs saved to: ${logger.logFilePath}`);
  console.log(`🔄 Keeping last ${logger.maxLogs} log entries`);
});

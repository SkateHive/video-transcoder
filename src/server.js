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
import { v4 as uuidv4 } from 'uuid';
import TranscodeLogger from './logger.js';


const app = express();
const logger = new TranscodeLogger();

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://skatehive.app,http://localhost:3000,http://localhost:19006').split(',').map(s => s.trim()).filter(Boolean);
const MOBILE_UPLOAD_TOKEN = process.env.MOBILE_UPLOAD_TOKEN || '';

function getRequestAccess(req) {
  const origin = req.get('Origin') || '';
  const mobileToken = req.get('X-Skatehive-Upload-Key') || '';
  const clientType = req.get('X-Skatehive-Client') || '';
  const hasAllowedOrigin = !!origin && ALLOWED_ORIGINS.includes(origin);
  const isMobileTokenValid = !!MOBILE_UPLOAD_TOKEN && mobileToken === MOBILE_UPLOAD_TOKEN;
  const isOriginlessRequest = !origin; // native mobile / server-to-server often send no Origin
  const allowed = hasAllowedOrigin || isMobileTokenValid || isOriginlessRequest;
  return { allowed, origin, hasAllowedOrigin, isMobileTokenValid, isOriginlessRequest, clientType };
}

/**
 * Check if video is web-optimized (H.264/AAC, faststart, reasonable size)
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

        const height = parseInt(videoStream.height);
        if (height > 1080) {
          return resolve({ optimized: false, reason: `resolution too high: ${height}p` });
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
  const payload = { ok: true, service: 'video-worker', timestamp: new Date().toISOString() };
  sendHealth(req, res, payload, 'Video Worker Health');
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

// Dashboard endpoints
app.get('/logs', (_req, res) => {
  const limit = parseInt(_req.query.limit) || 10;
  const logs = logger.getLogsForDashboard(limit);
  res.json({ logs, stats: logger.getStats() });
});

app.get('/stats', (_req, res) => {
  res.json(logger.getStats());
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
async function generateThumbnail(videoPath, videoDuration) {
  const thumbPath = path.join(os.tmpdir(), `thumb-${uuidv4()}.jpg`);
  // Capture at 10% of duration, capped at 5s, minimum 0.5s
  const captureTime = Math.min(Math.max((videoDuration || 2) * 0.1, 0.5), 5);

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

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(thumbPath)) {
        resolve(thumbPath);
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => resolve(null));
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
      if (code === 0) {
        console.log(`✅ [FFMPEG-SUCCESS] ID: ${requestId} | Duration: ${duration}ms`);
        broadcastProgress(requestId, 80, 'uploading'); // Transcoding done, now uploading
        resolve({ ok: true });
      } else {
        console.error(`❌ [FFMPEG-ERROR] ID: ${requestId} | Code: ${code} | Duration: ${duration}ms | Error: ${stderr.slice(-400)}`);
        broadcastProgress(requestId, 0, 'error');
        reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-4000)}`));
      }
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

  // Initialize job tracking for SSE - PRESERVE existing clients if SSE connected first!
  const existingJob = activeJobs.get(requestId);
  const clients = existingJob?.clients || new Set();
  activeJobs.set(requestId, { progress: 0, stage: 'starting', clients });
  console.log(`📡 SSE clients for ${requestId}: ${clients.size}`);
  broadcastProgress(requestId, 5, 'receiving');

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
        '-vf', 'scale=min(iw\\,1920):min(ih\\,1080):force_original_aspect_ratio=decrease',
        '-maxrate', '5M',
        '-bufsize', '10M',
        '-pix_fmt', 'yuv420p', // 8-bit 4:2:0 — required for universal mobile hardware decode
        '-c:a', 'aac',
        '-b:a', process.env.AAC_BITRATE || '128k',
        '-movflags', '+faststart',
        outputPath
      ];

      await runFfmpeg(ffArgs, requestId, videoDuration);
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
        onUploadProgress: (progressEvent) => {
          // Calculate upload progress (85-100% range)
          if (progressEvent.total) {
            const uploadPercent = Math.round((progressEvent.loaded / progressEvent.total) * 15);
            broadcastProgress(requestId, 85 + uploadPercent, 'uploading');
          }
        }
      }
    );

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
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    const totalDuration = Date.now() - startTime;

    // Broadcast error to SSE clients
    broadcastProgress(requestId, 0, 'error');

    // Enhanced error logging for debugging Pinata issues
    console.error('❌ [PINATA-ERROR] Full error details:', {
      message: err.message,
      response: err.response?.data,
      status: err.response?.status,
      headers: err.response?.headers
    });

    // Log error
    logger.logTranscodeError({
      id: requestId,
      user: creator,
      filename: req.file?.originalname || 'unknown',
      error: err.message || err,
      duration: totalDuration,
      clientIP
    });

    res.status(500).json({
      error: err.message || 'Transcode failed',
      requestId,
      duration: totalDuration,
      timestamp: new Date().toISOString()
    });
  } finally {
    // Cleanup - only delete transcoded file if different from input
    try { fs.unlinkSync(inputPath); } catch { }
    if (needsTranscoding && outputPath && outputPath !== inputPath) {
      try { fs.unlinkSync(outputPath); } catch { }
    }

    // Clean up job tracking after a delay (let SSE clients receive final state)
    setTimeout(() => {
      if (activeJobs.has(requestId)) {
        const job = activeJobs.get(requestId);
        job?.clients?.forEach(client => {
          try { client.end(); } catch { }
        });
        activeJobs.delete(requestId);
      }
    }, 5000);
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

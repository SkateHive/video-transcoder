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

// Store active transcoding progress for SSE clients
const activeJobs = new Map(); // requestId -> { progress, stage, clients: Set<Response> }

// Enhanced CORS setup for web application compatibility
// --- CORS configuration ---
// Allow requests from any origin

// Additional CORS headers for maximum compatibility
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,PUT,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
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
const PINATA_GATEWAY = process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud/ipfs';

if (!PINATA_JWT) {
  console.warn('⚠️  PINATA_JWT is not set. Set it in your environment before starting.');
}

// Morgan logging for HTTP requests
app.use(morgan('combined'));

// Morgan logging for HTTP requests
app.use(morgan('combined'));
app.get('/', (_req, res) => res.send('🎬 Video Worker - Ready for transcoding!'));
app.head('/', (_req, res) => res.sendStatus(200));
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'video-worker', timestamp: new Date().toISOString() }));

// SSE endpoint for progress streaming
app.get('/progress/:requestId', (req, res) => {
  const { requestId } = req.params;
  
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
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
  const outName = `${uuidv4()}.mp4`;
  const outputPath = path.join(os.tmpdir(), outName);

  // Initialize job tracking for SSE - PRESERVE existing clients if SSE connected first!
  const existingJob = activeJobs.get(requestId);
  const clients = existingJob?.clients || new Set();
  activeJobs.set(requestId, { progress: 0, stage: 'starting', clients });
  console.log(`📡 SSE clients for ${requestId}: ${clients.size}`);
  broadcastProgress(requestId, 5, 'receiving');

  try {
    // Get video duration for progress calculation
    const videoDuration = await getVideoDuration(inputPath);
    console.log(`📏 Video duration: ${videoDuration}s`);
    
    broadcastProgress(requestId, 10, 'transcoding');
    
    // Transcode to a broadly compatible H.264/AAC MP4
    const ffArgs = [
      '-y',
      '-i', inputPath,
      '-c:v', 'libx264',
      '-preset', process.env.X264_PRESET || 'veryfast',
      '-crf', process.env.X264_CRF || '22',
      '-c:a', 'aac',
      '-b:a', process.env.AAC_BITRATE || '128k',
      '-movflags', '+faststart',
      outputPath
    ];

    await runFfmpeg(ffArgs, requestId, videoDuration);

    // Upload to Pinata
    if (!PINATA_JWT) {
      throw new Error('PINATA_JWT not configured on server');
    }

    const thumbnailRaw = (req.body?.thumbnail ?? req.body?.thumbnailUrl ?? '').toString().trim();
    const thumbnail = thumbnailRaw ? thumbnailRaw.slice(0, 2048) : '';

    const form = new FormData();
    form.append('file', fs.createReadStream(outputPath), { filename: outName, contentType: 'video/mp4' });

    // Pinata metadata with rich keyvalues
    // All values stored for analytics and debugging
    const metadata = {
      name: `${sourceApp}-${creator}-${new Date().toISOString()}.mp4`,
      keyvalues: {
        creator,
        source_app: sourceApp,        // 'webapp' | 'mobile' | 'unknown'
        app_version: appVersion,       // e.g., '1.2.3' or ''
        requestId,
        platform,
        deviceInfo: deviceDetails,
        userHP: userHP ? userHP.toString() : '',
        clientIP: clientIP.substring(0, 20), // truncated for privacy
        ...(thumbnail ? { thumbnail } : {})
      }
    };
    form.append('pinataMetadata', JSON.stringify(metadata));

    const options = { cidVersion: 1 };
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
    // Cleanup
    try {
      fs.unlinkSync(inputPath);
    } catch { }
    try {
      fs.unlinkSync(outputPath);
    } catch { }
    
    // Clean up job tracking after a delay (let SSE clients receive final state)
    setTimeout(() => {
      activeJobs.delete(requestId);
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

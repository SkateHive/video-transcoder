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
const activeJobs = new Map();

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,PUT,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Request logging
app.use((req, res, next) => {
  const startTime = Date.now();
  const clientIP = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
  const origin = req.get('Origin') || req.get('Referer') || 'direct';
  console.log(`🌐 [${new Date().toISOString()}] ${req.method} ${req.path} - Client: ${clientIP} - Origin: ${origin}`);
  if (req.path === '/transcode') {
    console.log(`📊 TRANSCODE REQUEST START: IP=${clientIP} Origin=${origin}`);
  }
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
  console.warn('⚠️  PINATA_JWT is not set.');
}

app.use(morgan('combined'));

// Health & info
app.get('/', (_req, res) => res.send('🎬 Video Worker - Ready for transcoding!'));
app.head('/', (_req, res) => res.sendStatus(200));
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'video-worker', timestamp: new Date().toISOString() }));

// SSE endpoint for real-time progress streaming
app.get('/progress/:requestId', (req, res) => {
  const { requestId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  if (!activeJobs.has(requestId)) {
    activeJobs.set(requestId, { progress: 0, stage: 'waiting', clients: new Set() });
  }

  const job = activeJobs.get(requestId);
  job.clients.add(res);
  res.write(`data: ${JSON.stringify({ progress: job.progress, stage: job.stage })}\n\n`);

  req.on('close', () => {
    job.clients.delete(res);
    if (job.clients.size === 0 && job.stage === 'complete') {
      activeJobs.delete(requestId);
    }
  });
});

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
  res.json({ logs: logger.getLogsForDashboard(limit), stats: logger.getStats() });
});

app.get('/stats', (_req, res) => {
  res.json(logger.getStats());
});

// Multer config
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
  }),
  limits: {
    fileSize: (process.env.MAX_UPLOAD_MB ? parseInt(process.env.MAX_UPLOAD_MB, 10) : 512) * 1024 * 1024
  }
});

// Get video duration via ffprobe
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

// Parse FFmpeg time to seconds
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
      const progressMatch = d.toString().match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
      if (progressMatch) {
        const timeElapsed = Date.now() - startTime;
        const currentTime = timeToSeconds(progressMatch[1]);
        let percent = 0;
        if (totalDuration > 0) {
          percent = Math.min(80, Math.round((currentTime / totalDuration) * 80));
        }
        broadcastProgress(requestId, percent, 'transcoding');
        logger.logFFmpegProgress({ id: requestId, progress: progressMatch[1], percent, timeElapsed });
      }
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      if (code === 0) {
        console.log(`✅ [FFMPEG-SUCCESS] ID: ${requestId} | Duration: ${duration}ms`);
        broadcastProgress(requestId, 80, 'uploading');
        resolve({ ok: true });
      } else {
        console.error(`❌ [FFMPEG-ERROR] ID: ${requestId} | Code: ${code} | Duration: ${duration}ms`);
        broadcastProgress(requestId, 0, 'error');
        reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-4000)}`));
      }
    });
  });
}

// POST /transcode
app.post('/transcode', upload.single('video'), async (req, res) => {
  const internalId = uuidv4().substring(0, 8);
  const startTime = Date.now();
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  const userAgent = req.get('User-Agent') || 'unknown';
  const origin = req.get('Origin') || req.get('Referer') || 'direct';

  const body = req.body || {};
  const creator = (body.creator || body.user || 'anonymous').toString().trim().slice(0, 64);
  const sourceApp = body.source_app || body.sourceApp || 'unknown';
  const platform = body.platform || 'unknown';

  // Use client correlationId for SSE progress (so client can subscribe before request)
  const correlationId = body.correlationId || null;
  const requestId = correlationId || internalId;

  console.log(`🔗 Request ID for SSE: ${requestId} (correlationId: ${correlationId || 'none'})`);

  logger.logTranscodeStart({
    id: requestId,
    user: creator,
    sourceApp,
    filename: req.file?.originalname || 'unknown',
    fileSize: req.file?.size || 0,
    clientIP,
    userAgent,
    origin,
    platform,
    correlationId
  });

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Send multipart/form-data with field "video".' });
  }

  const inputPath = req.file.path;
  const outName = `${uuidv4()}.mp4`;
  const outputPath = path.join(os.tmpdir(), outName);

  // Initialize SSE job tracking - preserve existing clients if SSE connected first
  const existingJob = activeJobs.get(requestId);
  const clients = existingJob?.clients || new Set();
  activeJobs.set(requestId, { progress: 0, stage: 'starting', clients });
  console.log(`📡 SSE clients for ${requestId}: ${clients.size}`);
  broadcastProgress(requestId, 5, 'receiving');

  try {
    const videoDuration = await getVideoDuration(inputPath);
    console.log(`📏 Video duration: ${videoDuration}s`);
    broadcastProgress(requestId, 10, 'transcoding');

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

    if (!PINATA_JWT) throw new Error('PINATA_JWT not configured on server');

    const thumbnailRaw = (body.thumbnail ?? body.thumbnailUrl ?? '').toString().trim();
    const thumbnail = thumbnailRaw ? thumbnailRaw.slice(0, 2048) : '';

    const form = new FormData();
    form.append('file', fs.createReadStream(outputPath), { filename: outName, contentType: 'video/mp4' });

    // Pinata metadata - max 10 keyvalues
    const uploadDate = new Date().toISOString();
    const metadata = {
      name: `${creator}-${uploadDate}.mp4`,
      keyvalues: {
        creator,
        source: 'video-worker',
        uploadDate,
        transcoded: 'true',
        originalFileName: req.file.originalname,
        videoDuration: videoDuration ? videoDuration.toFixed(2) : 'unknown',
        requestId,
        ...(sourceApp && sourceApp !== 'unknown' && { sourceApp }),
        ...(platform && platform !== 'unknown' && { platform }),
        ...(thumbnail && { thumbnailUrl: thumbnail })
      }
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
        headers: { ...form.getHeaders(), Authorization: `Bearer ${PINATA_JWT}` },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        onUploadProgress: (progressEvent) => {
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

    broadcastProgress(requestId, 100, 'complete');

    logger.logTranscodeComplete({
      id: requestId,
      user: creator,
      filename: req.file.originalname,
      cid,
      gatewayUrl,
      duration: totalDuration,
      clientIP
    });

    res.status(200).json({ cid, gatewayUrl, requestId, duration: totalDuration, creator, sourceApp, timestamp: uploadDate });

  } catch (err) {
    const totalDuration = Date.now() - startTime;
    broadcastProgress(requestId, 0, 'error');

    console.error('❌ [ERROR] Full details:', {
      message: err.message,
      response: err.response?.data,
      status: err.response?.status
    });

    logger.logTranscodeError({
      id: requestId,
      user: creator,
      filename: req.file?.originalname || 'unknown',
      error: err.message || err,
      duration: totalDuration,
      clientIP
    });

    res.status(500).json({ error: err.message || 'Transcode failed', requestId, duration: totalDuration, timestamp: new Date().toISOString() });

  } finally {
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
    setTimeout(() => { activeJobs.delete(requestId); }, 5000);
  }
});

app.listen(PORT, () => {
  console.log(`🎬 Video worker listening on :${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/healthz`);
  console.log(`🎯 Transcode endpoint: http://localhost:${PORT}/transcode`);
  console.log(`🌊 Progress SSE: http://localhost:${PORT}/progress/:requestId`);
  console.log(`📊 Logs: http://localhost:${PORT}/logs`);
  console.log(`📈 Stats: http://localhost:${PORT}/stats`);
  console.log(`🌐 Gateway: ${PINATA_GATEWAY}`);
  if (PINATA_GROUP_VIDEOS) console.log(`📁 Pinata Group: ${PINATA_GROUP_VIDEOS}`);
});

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

function runFfmpeg(args, requestId = 'unknown') {
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
        logger.logFFmpegProgress({
          id: requestId,
          progress: progressMatch[1],
          timeElapsed
        });
      }
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      if (code === 0) {
        console.log(`✅ [FFMPEG-SUCCESS] ID: ${requestId} | Duration: ${duration}ms`);
        resolve({ ok: true });
      } else {
        console.error(`❌ [FFMPEG-ERROR] ID: ${requestId} | Code: ${code} | Duration: ${duration}ms | Error: ${stderr.slice(-400)}`);
        reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-4000)}`));
      }
    });
  });
}

// POST /transcode  (multipart form fields: video [required], creator [optional], thumbnail [optional], platform [optional], deviceInfo [optional])
app.post('/transcode', upload.single('video'), async (req, res) => {
  const requestId = uuidv4().substring(0, 8); // Short ID for logging
  const startTime = Date.now();
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  const userAgent = req.get('User-Agent') || 'unknown';
  const origin = req.get('Origin') || req.get('Referer') || 'direct';

  // Extract rich user information from form data
  // Get rich user data from form (with backward compatibility)
  // req.body may be undefined if multer didn't parse the request (e.g. wrong content-type)
  const body = req.body || {};
  const creator = body.creator || body.user || 'anonymous';
  const platform = body.platform || 'unknown';
  const deviceInfo = body.deviceInfo || '';
  const browserInfo = body.browserInfo || '';
  const userHP = body.userHP || null;
  const correlationId = body.correlationId || null;
  const viewport = body.viewport || null;
  const connectionType = body.connectionType || null;  // Parse device info from User-Agent if not provided
  const deviceDetails = parseDeviceInfo(userAgent, deviceInfo);

  // Log transcode start
  logger.logTranscodeStart({
    id: requestId,
    user: creator,
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

  try {
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

    await runFfmpeg(ffArgs, requestId);

    // Upload to Pinata
    if (!PINATA_JWT) {
      throw new Error('PINATA_JWT not configured on server');
    }

    const thumbnailRaw = (req.body?.thumbnail ?? req.body?.thumbnailUrl ?? '').toString().trim();
    const thumbnail = thumbnailRaw ? thumbnailRaw.slice(0, 2048) : '';

    const form = new FormData();
    form.append('file', fs.createReadStream(outputPath), { filename: outName, contentType: 'video/mp4' });

    // Pinata metadata with rich keyvalues
    const metadata = {
      name: `transcoded-${new Date().toISOString()}.mp4`,
      keyvalues: {
        creator,
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
      }
    );

    const { IpfsHash: cid } = resp.data;
    const gatewayUrl = `${PINATA_GATEWAY.replace(/\/+$/, '')}/${cid}`;
    const totalDuration = Date.now() - startTime;

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
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    const totalDuration = Date.now() - startTime;

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
  }
});

app.listen(PORT, () => {
  console.log(`🎬 Video worker listening on :${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/healthz`);
  console.log(`🎯 Transcode endpoint: http://localhost:${PORT}/transcode`);
  console.log(`📊 Logs endpoint: http://localhost:${PORT}/logs`);
  console.log(`📈 Stats endpoint: http://localhost:${PORT}/stats`);
  console.log(`📋 Dashboard monitoring enabled with structured logging`);
  console.log(`📁 Logs saved to: ${logger.logFilePath}`);
  console.log(`🔄 Keeping last ${logger.maxLogs} log entries`);
});

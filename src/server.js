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

const app = express();

// Open CORS (no credentials). Put this BEFORE routes.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Keep health probes happy
app.get('/', (_req, res) => res.send('🎬 Video Worker - Ready for transcoding!'));
app.head('/', (_req, res) => res.sendStatus(200));

const PORT = process.env.PORT || 8080;
const PINATA_JWT = process.env.PINATA_JWT;
const PINATA_GATEWAY = process.env.PINATA_GATEWAY || 'https://ipfs.skatehive.app/ipfs';
const PINATA_GROUP_VIDEOS = process.env.PINATA_GROUP_VIDEOS || null;

if (!PINATA_JWT) {
  console.warn('⚠️  PINATA_JWT is not set. Set it in your environment before starting.');
}

app.use(morgan('combined'));
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'video-worker', timestamp: new Date().toISOString() }));

// Configure multer to write incoming file to the OS temp dir
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
  }),
  limits: {
    fileSize: (process.env.MAX_UPLOAD_MB ? parseInt(process.env.MAX_UPLOAD_MB, 10) : 512) * 1024 * 1024
  }
});

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

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-4000)}`));
    });
  });
}

// POST /transcode  (multipart: video [required], creator [optional], thumbnail/thumbnailUrl [optional])
app.post('/transcode', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Send multipart/form-data with field "video".' });
  }

  const requestId = uuidv4().substring(0, 8);
  const startTime = Date.now();
  const inputPath = req.file.path;
  const outName = `${uuidv4()}.mp4`;
  const outputPath = path.join(os.tmpdir(), outName);

  try {
    // Get video duration for metadata
    const videoDuration = await getVideoDuration(inputPath);

    // Transcode to H.264/AAC MP4
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
    await runFfmpeg(ffArgs);

    // Upload to Pinata
    if (!PINATA_JWT) {
      throw new Error('PINATA_JWT not configured on server');
    }

    // Read optional form fields
    const body = req.body || {};
    const creator = (body.creator || 'anonymous').toString().trim().slice(0, 64);
    const sourceApp = body.source_app || body.sourceApp || 'unknown';
    const platform = body.platform || 'unknown';
    const thumbnailRaw = (body.thumbnail ?? body.thumbnailUrl ?? '').toString().trim();
    const thumbnail = thumbnailRaw ? thumbnailRaw.slice(0, 2048) : '';

    const form = new FormData();
    form.append('file', fs.createReadStream(outputPath), { filename: outName, contentType: 'video/mp4' });

    // Pinata metadata - standardized schema (max 10 keyvalues)
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

    // Pinata options - Groups support for organized uploads
    const options = {
      cidVersion: 1,
      ...(PINATA_GROUP_VIDEOS && { groupId: PINATA_GROUP_VIDEOS })
    };
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

    console.log(`✅ Transcoded & uploaded: ${req.file.originalname} → ${cid} (${totalDuration}ms)`);

    res.status(200).json({
      cid,
      gatewayUrl,
      requestId,
      duration: totalDuration,
      creator,
      sourceApp,
      timestamp: uploadDate
    });

  } catch (err) {
    const totalDuration = Date.now() - startTime;
    console.error(`❌ Transcode failed: ${err.message}`, {
      requestId,
      file: req.file?.originalname,
      duration: totalDuration,
      pinataError: err.response?.data
    });
    res.status(500).json({
      error: err.message || 'Transcode failed',
      requestId,
      duration: totalDuration
    });
  } finally {
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`🎬 Video worker listening on :${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/healthz`);
  console.log(`🎯 Transcode endpoint: http://localhost:${PORT}/transcode`);
  console.log(`🌐 Gateway: ${PINATA_GATEWAY}`);
  if (PINATA_GROUP_VIDEOS) console.log(`📁 Pinata Group: ${PINATA_GROUP_VIDEOS}`);
});

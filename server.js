/**
 * server.js
 * - Minimal Node/Express server with endpoints:
 *   GET /ping
 *   GET /download?size=MB
 *   POST /upload
 * - Includes basic rate limiting and upload validation.
 * - For production: run behind HTTPS (Nginx/Cloud provider) and use CDN/S3 for heavy payloads.
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { RateLimiterMemory } = require('rate-limit-flexible');
const crypto = require('crypto');

const app = express();
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB per file cap

const PORT = process.env.PORT || 3000;
const MAX_DOWNLOAD_MB = 128;
const DEFAULT_DOWNLOAD_MB = 8;

// Basic CORS (adjust origin in production)
app.use(cors({ origin: true }));

// Serve static client files
app.use(express.static('public', { maxAge: 0 }));

// Rate limiter: per IP
const rateLimiter = new RateLimiterMemory({
  points: 60, // 60 requests
  duration: 60 // per 60 seconds
});
app.use(async (req, res, next) => {
  try {
    await rateLimiter.consume(req.ip);
    next();
  } catch (rejRes) {
    res.status(429).json({ error: 'Too many requests' });
  }
});

// Ping endpoint returns server time for diagnostics
app.get('/ping', (req, res) => {
  const serverTime = Date.now();
  res.json({ ok: true, serverTime });
});

// Download endpoint: returns random bytes (or redirect to CDN/S3 in production)
app.get('/download', (req, res) => {
  let sizeMB = parseFloat(req.query.size) || DEFAULT_DOWNLOAD_MB;
  if(sizeMB <= 0) sizeMB = DEFAULT_DOWNLOAD_MB;
  if(sizeMB > MAX_DOWNLOAD_MB) sizeMB = MAX_DOWNLOAD_MB;
  const bytes = Math.round(sizeMB * 1024 * 1024);

  // For production: return a redirect to a pre-signed S3/Cloud CDN object instead of generating buffer.
  // Here we generate pseudo-random buffer in chunks to avoid huge memory spikes.
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': bytes,
    'Cache-Control': 'no-store, no-cache, must-revalidate'
  });

  // Stream random data in chunks
  const chunkSize = 64 * 1024;
  let sent = 0;
  function sendChunk(){
    if(sent >= bytes){ return res.end(); }
    const remaining = Math.min(chunkSize, bytes - sent);
    const buf = crypto.randomBytes(remaining);
    const ok = res.write(buf);
    sent += remaining;
    if(!ok) res.once('drain', sendChunk); else setImmediate(sendChunk);
  }
  sendChunk();
});

// Upload endpoint: accepts raw POSTs or multipart; validates size and content-type
app.post('/upload', upload.any(), (req, res) => {
  // If multer parsed files, they are in req.files; otherwise body was raw and not parsed.
  // We don't store uploads; we simply accept and respond quickly.
  // Validate total size (if Content-Length provided)
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  const MAX_TOTAL_UPLOAD = 200 * 1024 * 1024; // 200MB cap per request
  if(contentLength && contentLength > MAX_TOTAL_UPLOAD){
    return res.status(413).json({ error: 'Upload too large' });
  }
  // Basic sanitization: check content-type
  const ct = req.headers['content-type'] || '';
  if(ct.includes('text/') || ct.includes('application/json')){
    // allow but warn
  }
  res.json({ ok: true, received: true, ts: Date.now() });
});

// Simple health endpoint
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
  console.log(`Speed test server listening on port ${PORT}`);
  console.log(`Open http://localhost:${PORT}`);
});

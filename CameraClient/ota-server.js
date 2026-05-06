import express from 'express';
import { createReadStream, readFileSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT          = parseInt(process.env.OTA_PORT || '80', 10);
const BACKEND_URL   = process.env.BACKEND_URL            || 'http://localhost:3001';
const FIRMWARE_PATH = join(__dirname, 'firmware', 'firmware.bin');
const VERSION_PATH  = join(__dirname, 'firmware', 'version.txt');

function firmwareVersion() {
  try { return readFileSync(VERSION_PATH, 'utf8').trim(); } catch { return 'unknown'; }
}

// Tell the backend to push OTA to all currently-connected cameras.
// Retried with backoff so cameras that connect shortly after the container
// starts are still caught (the backend may also need a moment to be ready).
async function notifyBackend(attemptsLeft = 5, delayMs = 3000) {
  try {
    const res = await fetch(`${BACKEND_URL}/ota/push-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ota-secret': process.env.OTA_SECRET || '' },
      body: JSON.stringify({ version: firmwareVersion() }),
    });
    const body = await res.json();
    console.log(`[OTA] Backend notified — pushed to ${body.pushed ?? '?'} camera(s), skipped ${body.skipped ?? 0} (already up to date)`);
  } catch (err) {
    if (attemptsLeft > 1) {
      console.warn(`[OTA] Backend not ready (${err.message}), retrying in ${delayMs}ms…`);
      setTimeout(() => notifyBackend(attemptsLeft - 1, delayMs * 2), delayMs);
    } else {
      console.error('[OTA] Could not reach backend after all retries:', err.message);
    }
  }
}

const app = express();

// GET /firmware.bin — served to ESP32 HTTPUpdate
app.get('/firmware.bin', (req, res) => {
  if (!existsSync(FIRMWARE_PATH)) {
    console.error('[OTA] firmware.bin not found at', FIRMWARE_PATH);
    return res.status(404).send('Firmware not found');
  }

  const stat = statSync(FIRMWARE_PATH);
  console.log(`[OTA] Serving firmware.bin (${stat.size} bytes) → ${req.ip}`);

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="firmware.bin"');
  res.setHeader('Content-Length', stat.size);

  const stream = createReadStream(FIRMWARE_PATH);
  stream.on('error', (err) => {
    console.error('[OTA] Stream error:', err.message);
    if (!res.headersSent) res.status(500).end();
  });
  stream.pipe(res);
});

// GET /healthz — liveness check used by Docker and the backend
app.get('/healthz', (_req, res) => {
  const ready = existsSync(FIRMWARE_PATH);
  const version = firmwareVersion();
  res.json({
    ok:    ready,
    ready,
    version,
    ...(ready ? { size: statSync(FIRMWARE_PATH).size } : {}),
  });
});

app.listen(PORT, '0.0.0.0', () => {
  const version = firmwareVersion();
  console.log(`[OTA] Firmware server listening on http://0.0.0.0:${PORT}`);
  console.log(`[OTA] Firmware version: ${version}`);
  if (existsSync(FIRMWARE_PATH)) {
    const { size } = statSync(FIRMWARE_PATH);
    console.log(`[OTA] Firmware ready: ${(size / 1024).toFixed(1)} KB — notifying backend`);
    notifyBackend();
  } else {
    console.warn('[OTA] firmware.bin not present — place it at firmware/firmware.bin');
  }
});

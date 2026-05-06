import 'dotenv/config';
import net from 'net';
import dgram from 'dgram';
import path from 'path';
import fs from 'fs';
import { spawn, spawnSync } from 'child_process';
import express from 'express';
import { EventEmitter } from 'events';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import jpeg from 'jpeg-js';
import sharp from 'sharp';
import motionDetect from 'motion-detect';
const { Motion } = motionDetect;

// ── Auth config ───────────────────────────────────────────────────────────────
// Set PV_USER / PV_PASS env vars to override defaults.
// Set JWT_SECRET to a long random string in production.
const AUTH_USER   = process.env.PV_USER   || 'admin';
const AUTH_PASS   = process.env.PV_PASS   || 'portalview';
const JWT_SECRET  = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'pv_token';

function signToken() {
  return jwt.sign({ ok: true }, JWT_SECRET, { expiresIn: '24h' });
}

function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie(COOKIE_NAME);
    res.status(401).json({ error: 'Token expired or invalid' });
  }
}

const TCP_PORT      = parseInt(process.env.TCP_PORT  || '9000', 10);  // ESP32 cameras connect here (control)
const UDP_PORT      = parseInt(process.env.UDP_PORT  || '9001', 10);  // ESP32 cameras send frames here
const HTTP_PORT     = parseInt(process.env.HTTP_PORT || '3001', 10);  // React frontend proxies to this
const OTA_HOST      = process.env.OTA_HOST || 'localhost';            // OTA firmware server host
const BOUNDARY      = 'mjpegboundary';
const RECORDINGS_DIR = path.join(process.cwd(), 'recordings');
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// ── camera registry ───────────────────────────────────────────────────────────
// Map<id, { address: string, latestFrame: Buffer|null, emitter: EventEmitter }>

const cameras = new Map();
const udpCamMap = new Map(); // djb2Hash(id) → cam  (for fast UDP packet routing)
const registryEmitter = new EventEmitter(); // fires 'change' when cameras join/leave
const bellEmitter     = new EventEmitter(); // fires 'bell' when a camera button is pressed

// djb2 hash — must match the implementation in CameraClient.ino
function djb2Hash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (((hash << 5) + hash) + str.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

// ── Camera state (persistent: sleepEnabled, battery, frameSize, name) ──────────
const CAMERA_STATES_FILE = path.join(process.cwd(), 'camera-states.json');

function loadCameraStates() {
  try { return JSON.parse(fs.readFileSync(CAMERA_STATES_FILE, 'utf8')); }
  catch { return {}; }
}

function saveCameraStates() {
  try { fs.writeFileSync(CAMERA_STATES_FILE, JSON.stringify(cameraStates, null, 2)); }
  catch (e) { console.error(`[States] Failed to save: ${e.message}`); }
}

const cameraStates = loadCameraStates(); // { [id]: { sleepEnabled: bool } }

// ── OTA version state (persistent) ───────────────────────────────────────────
// Tracks the firmware version currently served by the OTA server so the backend
// can detect stale cameras even after a restart.
const OTA_STATE_FILE = path.join(process.cwd(), 'ota-state.json');
let latestFirmwareVersion = null;
try {
  latestFirmwareVersion = JSON.parse(fs.readFileSync(OTA_STATE_FILE, 'utf8')).version || null;
} catch { /* first run */ }

function saveOtaState() {
  try { fs.writeFileSync(OTA_STATE_FILE, JSON.stringify({ version: latestFirmwareVersion })); }
  catch (e) { console.error(`[OTA] Failed to save state: ${e.message}`); }
}

function cameraList() {
  const connected = new Set(cameras.keys());
  const list = [...cameras.entries()].map(([id, { address, recorder, manualRecord, frameTs, battery, frameSize, firmwareVersion }]) => ({
    id,
    address,
    name:            cameraStates[id]?.name || null,
    recording:       !!recorder,
    manualRecord:    !!manualRecord,
    fps:             calcFps(frameTs),
    recStartedAt:    recorder ? recorder.startedAt : null,
    battery:         battery != null ? battery : null,
    connected:       true,
    sleepEnabled:    cameraStates[id]?.sleepEnabled ?? false,
    frameSize:       frameSize ?? DEFAULT_FRAMESIZE,
    firmwareVersion: firmwareVersion ?? null,
    firmwareLatest:  latestFirmwareVersion,
    firmwareUpToDate: latestFirmwareVersion ? firmwareVersion === latestFirmwareVersion : null,
  }));

  // Include offline cameras that are known from previous sessions
  for (const id of Object.keys(cameraStates)) {
    if (!connected.has(id)) {
      list.push({
        id,
        address:          null,
        name:             cameraStates[id]?.name || null,
        recording:        false,
        manualRecord:     false,
        fps:              null,
        recStartedAt:     null,
        battery:          cameraStates[id].battery ?? null,
        connected:        false,
        sleepEnabled:     cameraStates[id]?.sleepEnabled ?? false,
        frameSize:        cameraStates[id]?.frameSize ?? DEFAULT_FRAMESIZE,
        firmwareVersion:  cameraStates[id]?.firmwareVersion ?? null,
        firmwareLatest:   latestFirmwareVersion,
        firmwareUpToDate: latestFirmwareVersion
          ? (cameraStates[id]?.firmwareVersion === latestFirmwareVersion)
          : null,
      });
    }
  }

  return list;
}

// Rolling FPS: keep last N timestamps, discard stale ones older than 2 s
const FPS_WINDOW   = 15;  // smaller = faster response to drops
const FPS_STALE_MS = 2000;
function calcFps(frameTs) {
  if (!frameTs || frameTs.length < 2) return null;
  const cutoff = Date.now() - FPS_STALE_MS;
  const recent = frameTs.filter(t => t >= cutoff);
  if (recent.length < 2) return null;
  const oldest = recent[0];
  const newest = recent[recent.length - 1];
  const secs   = (newest - oldest) / 1000;
  if (secs <= 0) return null;
  return Math.round(((recent.length - 1) / secs) * 10) / 10; // one decimal
}

function makeId(socket) {
  // Use remote address + port as a fallback identifier (when no ID handshake)
  return `${socket.remoteAddress}_${socket.remotePort}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

// ── Motion detection ─────────────────────────────────────────────────────────
// Subsample factor: analyse every Nth pixel to avoid decoding full QXGA RGBA
const SUBSAMPLE            = 8;
// Analysis rate-limit in active mode (no need to analyse every frame at 15fps)
const ANALYSIS_INTERVAL_MS = 500;

// Runtime-editable settings (modified via GET/PUT /settings)
const SETTINGS_FILE = path.join(process.cwd(), 'settings.json');

const SETTINGS_DEFAULTS = {
  motionEnabled:    true,
  noMotionSecs:     180,
  recordingEnabled: true,
  recordOnBell:     false,
  maxStorageGB:     10,
  manualRecordMins: 30,
  timezone:         Intl.DateTimeFormat().resolvedOptions().timeZone,
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    return { ...SETTINGS_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error(`[Settings] Failed to save: ${e.message}`);
  }
}

const settings = loadSettings();

const CMD_ACTIVE  = Buffer.from([0x01]); // tell ESP32: full framerate
const CMD_STANDBY = Buffer.from([0x00]); // tell ESP32: 1 frame per 5 s
const CMD_SLEEP   = Buffer.from([0x02]); // tell ESP32: enter deep sleep
const CMD_OTA     = Buffer.from([0x10]); // tell ESP32: download + apply OTA firmware

// Frame size commands (0x03–0x06)
const FRAMESIZES = {
  SXGA: { cmd: Buffer.from([0x03]), label: 'SXGA', width: 1280, height: 1024 },
  UXGA: { cmd: Buffer.from([0x04]), label: 'UXGA', width: 1600, height: 1200 },
  FHD:  { cmd: Buffer.from([0x05]), label: 'FHD',  width: 1920, height: 1080 },
  QXGA: { cmd: Buffer.from([0x06]), label: 'QXGA', width: 2048, height: 1536 },
};
const DEFAULT_FRAMESIZE = 'QXGA';

// ── Hardware encoder detection ────────────────────────────────────────────────
// Priority: h264_nvenc (NVIDIA) → h264_qsv (Intel QuickSync) → libx264 (CPU)

let HW_ENCODER   = 'libx264';
let HW_EXTRA_ARGS = ['-preset', 'ultrafast'];

// Hardware encoding (nvenc/quicksync) disabled — using libx264 (CPU)
console.log('[Rec] Hardware encoder: libx264 (CPU fallback)');

// ── Video recording ──────────────────────────────────────────────────────────

function enforceStorageQuota() {
  const maxBytes = settings.maxStorageGB * 1024 ** 3;
  let files;
  try {
    // Walk all per-camera subdirectories
    files = fs.readdirSync(RECORDINGS_DIR, { withFileTypes: true })
      .flatMap(entry => {
        if (entry.isDirectory()) {
          const subdir = path.join(RECORDINGS_DIR, entry.name);
          try {
            return fs.readdirSync(subdir)
              .filter(f => f.endsWith('.mp4'))
              .map(f => {
                const p = path.join(subdir, f);
                const s = fs.statSync(p);
                return { path: p, size: s.size, mtime: s.mtimeMs };
              });
          } catch { return []; }
        }
        // Also handle any legacy files directly in recordings/
        if (entry.isFile() && entry.name.endsWith('.mp4')) {
          const p = path.join(RECORDINGS_DIR, entry.name);
          const s = fs.statSync(p);
          return [{ path: p, size: s.size, mtime: s.mtimeMs }];
        }
        return [];
      })
      .sort((a, b) => a.mtime - b.mtime); // oldest first
  } catch { return; }

  let total = files.reduce((sum, f) => sum + f.size, 0);
  for (const file of files) {
    if (total <= maxBytes) break;
    try {
      fs.unlinkSync(file.path);
      console.log(`[Rec] Quota: deleted ${path.basename(file.path)}`);
      total -= file.size;
    } catch { /* skip */ }
  }
}

function startRecording(cam, manual = false) {
  if ((!manual && !settings.recordingEnabled) || cam.recorder) return;

  enforceStorageQuota();

  const camDir = path.join(RECORDINGS_DIR, cam.id);
  fs.mkdirSync(camDir, { recursive: true });

  const ts   = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${ts}.mp4`;
  const fp   = path.join(camDir, name);

  let ffmpeg;
  try {
    ffmpeg = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-use_wallclock_as_timestamps', '1',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-i', 'pipe:0',
      '-c:v', HW_ENCODER,
      ...HW_EXTRA_ARGS,
      '-pix_fmt', 'yuv420p',
      '-vsync', 'vfr',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-y', fp,
    ]);
  } catch (e) {
    console.error(`[Rec] Could not start ffmpeg: ${e.message}`);
    return;
  }

  ffmpeg.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[ffmpeg] ${msg}`);
  });
  ffmpeg.on('exit', (code) =>
    console.log(`[Rec] Finished: ${name} (exit ${code})`)
  );

  cam.recorder = { process: ffmpeg, path: fp, startedAt: Date.now() };
  cam.manualRecord = manual;
  console.log(`[Rec] Started${manual ? ' (manual)' : ''}: ${name}`);
  registryEmitter.emit('change');

  // Always record at full framerate
  if (!cam.isActive) {
    cam.isActive = true;
    if (!cam.socket.destroyed) cam.socket.write(CMD_ACTIVE);
  }

  // Auto-split after 10 minutes
  cam.recorder.splitTimer = setTimeout(() => {
    console.log(`[Rec] Max duration reached for ${cam.address}, splitting`);
    stopRecording(cam);
    startRecording(cam, manual);
  }, 10 * 60 * 1000);

  if (manual) {
    // Auto-stop after manualRecordMins
    clearTimeout(cam.manualRecordTimer);
    cam.manualRecordTimer = setTimeout(() => {
      console.log(`[Rec] Manual recording timeout for ${cam.address}`);
      stopRecording(cam);
    }, settings.manualRecordMins * 60 * 1000);
  }
}

function stopRecording(cam) {
  if (!cam.recorder) return;
  try { cam.recorder.process.stdin.end(); } catch { /* already closed */ }
  clearTimeout(cam.recorder.splitTimer);
  cam.recorder = null;
  cam.manualRecord = false;
  clearTimeout(cam.manualRecordTimer);
  cam.manualRecordTimer = null;
  registryEmitter.emit('change');
}

async function stampFrame(frame, address) {
  try {
    const { width } = await sharp(frame).metadata();
    const now    = new Date();
    const fmt    = new Intl.DateTimeFormat('sv-SE', {
      timeZone:       settings.timezone,
      year:   'numeric', month:  '2-digit', day:    '2-digit',
      hour:   '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const label  = `${address}  ${fmt.format(now).replace('T', ' ')}`;
    const tz     = settings.timezone.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // Escape characters that are special in SVG
    const escaped = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const tzEsc   = `  (${tz})`;
    const svgOverlay = Buffer.from(
      `<svg width="${width}" height="54">` +
      `<rect width="${width}" height="54" fill="rgba(0,0,0,0.52)"/>` +
      `<text x="10" y="24" font-family="monospace" font-size="20" fill="white">${escaped}</text>` +
      `<text x="10" y="46" font-family="monospace" font-size="16" fill="rgba(255,255,255,0.6)">${tzEsc}</text>` +
      `</svg>`
    );
    return await sharp(frame)
      .composite([{ input: svgOverlay, top: 0, left: 0 }])
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    return frame; // fallback: return unstamped frame rather than drop it
  }
}

async function writeRecordingFrame(cam, frame) {
  if (!cam.recorder) return;
  const stdin = cam.recorder.process.stdin;
  if (stdin.destroyed || stdin.writableEnded) return;
  try {
    const stamped = await stampFrame(frame, cameraStates[cam.id]?.name || cam.id);
    if (!stdin.destroyed && !stdin.writableEnded) stdin.write(stamped);
  } catch { stopRecording(cam); }
}

function analyzeFrame(cam, frame) {
  // Manual recording holds the camera at full framerate — skip standby logic
  if (cam.manualRecord) return;

  const needsDetection = settings.motionEnabled || settings.recordingEnabled;

  if (!needsDetection) {
    // Neither fps-reduction nor motion recording: keep camera active always
    if (!cam.isActive) {
      cam.isActive = true;
      if (!cam.socket.destroyed) cam.socket.write(CMD_ACTIVE);
    }
    return;
  }

  const now = Date.now();
  if (cam.isActive && !settings.motionEnabled && now - cam.lastAnalyzed < ANALYSIS_INTERVAL_MS) return;
  if (cam.isActive && settings.motionEnabled && now - cam.lastAnalyzed < ANALYSIS_INTERVAL_MS) return;
  cam.lastAnalyzed = now;

  let decoded;
  try {
    decoded = jpeg.decode(frame, { useTArray: true, maxMemoryUsageInMB: 256 });
  } catch {
    return; // partial / corrupted frame — skip
  }

  const { width, height, data } = decoded;
  const sw = Math.ceil(width  / SUBSAMPLE);
  const sh = Math.ceil(height / SUBSAMPLE);
  const sampled = new Uint8Array(sw * sh * 4);
  let si = 0;
  for (let y = 0; y < height; y += SUBSAMPLE) {
    for (let x = 0; x < width; x += SUBSAMPLE) {
      const i = (y * width + x) * 4;
      sampled[si++] = data[i];
      sampled[si++] = data[i + 1];
      sampled[si++] = data[i + 2];
      sampled[si++] = data[i + 3];
    }
  }

  const detected = cam.motion.detect(sampled);

  if (detected) {
    // Activate full framerate only if fps-reduction is enabled
    if (settings.motionEnabled && !cam.isActive) {
      console.log(`[Motion] ${cam.address}: motion detected → active`);
      cam.isActive = true;
      if (!cam.socket.destroyed) cam.socket.write(CMD_ACTIVE);
    }
    // Start recording on motion if enabled and not already recording
    if (settings.recordingEnabled && !cam.recorder) {
      console.log(`[Motion] ${cam.address}: motion detected → recording`);
      startRecording(cam);
    }
    // Reset the no-motion countdown
    clearTimeout(cam.noMotionTimer);
    cam.noMotionTimer = setTimeout(() => {
      // Go to standby only if fps-reduction is enabled
      if (settings.motionEnabled) {
        console.log(`[Motion] ${cam.address}: no motion for ${settings.noMotionSecs}s → standby`);
        cam.isActive = false;
        if (!cam.socket.destroyed) cam.socket.write(CMD_STANDBY);
      }
      // Stop recording if motion-recording is enabled
      if (settings.recordingEnabled) stopRecording(cam);
    }, settings.noMotionSecs * 1000);
  }
}

// ── Top-level frame processor (called from UDP reassembly) ──────────────────
function processFrame(cam, frame) {
  cam.latestFrame = frame;
  cam.emitter.emit('frame', frame);
  if (cam.isActive) {
    cam.frameTs.push(Date.now());
    if (cam.frameTs.length > FPS_WINDOW) cam.frameTs.shift();
  }
  writeRecordingFrame(cam, frame);
  analyzeFrame(cam, frame);
}

// ── TCP server — one connection per ESP32-S3 ──────────────────────────────────
// TCP carries: camera ID handshake, battery reports, 0xFE heartbeats.
// Frame data arrives separately via UDP on UDP_PORT.

// Heartbeats come every 5 s; allow 3 misses → 15 s idle timeout.
const SOCKET_IDLE_TIMEOUT_MS = 15_000;

const tcpServer = net.createServer((socket) => {
  const fallbackId = makeId(socket);
  const address    = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[TCP] Camera connected: ${address}`);

  // Detect half-open / silent connections: destroy after SOCKET_IDLE_TIMEOUT_MS of silence
  socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS);
  socket.on('timeout', () => {
    console.warn(`[TCP] Idle timeout for ${address} — closing`);
    socket.destroy();
  });

  // Camera object is created after we receive the ID handshake
  let cam = null;

  let buf = Buffer.alloc(0);
  let idReceived = false;

  const registerCamera = (id) => {
    // Ensure persistent state exists for this camera
    if (!cameraStates[id]) {
      cameraStates[id] = { sleepEnabled: false, battery: null, frameSize: DEFAULT_FRAMESIZE };
      saveCameraStates();
    }

    cam = {
      id,
      address,
      socket,
      latestFrame:  null,
      emitter:      new EventEmitter(),
      // Motion detection state
      motion:        new Motion(),
      isActive:      false,   // starts in standby — ESP32 also starts in standby
      noMotionTimer: null,
      lastAnalyzed:  0,
      // Recording state
      recorder:          null,
      manualRecord:      false,
      manualRecordTimer: null,
      // FPS tracking (rolling window of arrival timestamps, active mode only)
      frameTs:           [],
      // Battery percentage — seed from last persisted value so it shows immediately
      battery:           cameraStates[id].battery ?? null,
      // Frame size
      frameSize:         cameraStates[id]?.frameSize ?? DEFAULT_FRAMESIZE,
      // Firmware version (reported via 0xFD sentinel after connect handshake)
      firmwareVersion:   cameraStates[id]?.firmwareVersion ?? null,
      // UDP frame reassembly
      udpHash:           djb2Hash(id),
      udpFrames:         new Map(), // frame_seq → { frags, received, total, ts }
    };
    cam.emitter.setMaxListeners(200);
    cameras.set(id, cam);
    udpCamMap.set(cam.udpHash, cam);
    console.log(`[TCP] Camera registered: ${address}  id=${id}${cameraStates[id]?.name ? `  name="${cameraStates[id].name}"` : ''}`);

    // If sleep mode is enabled, command the camera to sleep immediately after handshake.
    // Do NOT send any other commands after CMD_SLEEP — the camera reads one byte
    // from the handshake window and immediately enters deep sleep, so any extra
    // bytes would be read as the first command on the next wake cycle.
    if (cameraStates[id].sleepEnabled) {
      console.log(`[Sleep] ${id}: sleep enabled → sending CMD_SLEEP`);
      socket.write(CMD_SLEEP);
    } else {
      // Restore frame size on reconnect (camera resets to default on reboot)
      const fsEntry = FRAMESIZES[cameraStates[id]?.frameSize ?? DEFAULT_FRAMESIZE];
      if (fsEntry) {
        console.log(`[FrameSize] ${id}: restoring ${fsEntry.label} on connect`);
        socket.write(fsEntry.cmd);
      }
    }

    registryEmitter.emit('change');
  };

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    while (buf.length >= 4) {
      const frameLen = buf.readUInt32BE(0);

      // Battery sentinel: top byte 0xFF, low byte = percentage 0-100, no payload
      if ((frameLen >>> 24) === 0xFF) {
        const pct = frameLen & 0xFF;
        buf = buf.slice(4);
        if (cam) {
          cam.battery = pct;
          if (cameraStates[cam.id]) {
            cameraStates[cam.id].battery = pct;
            saveCameraStates();
          }
          console.log(`[Battery] ${cam.id}: ${pct}%`);
          registryEmitter.emit('change');
        }
        continue;
      }

      // Heartbeat sentinel: top byte 0xFE, no payload — just resets the idle timer
      if ((frameLen >>> 24) === 0xFE) {
        buf = buf.slice(4);
        continue;
      }

      // Button press sentinel: top byte 0xFC, no payload
      if ((frameLen >>> 24) === 0xFC) {
        buf = buf.slice(4);
        if (cam) {
          console.log(`[Button] ${cam.id}: pressed`);
          bellEmitter.emit('bell', { id: cam.id, name: cameraStates[cam.id]?.name || null });
          if (settings.recordOnBell) startRecording(cam, true);
        }
        continue;
      }

      // Firmware version sentinel: top byte 0xFD, lower 3 bytes = string length.
      // Sent by the camera once per connection, right after the ID + battery handshake.
      // If the reported version doesn't match latestFirmwareVersion the camera is
      // immediately commanded to update.
      if ((frameLen >>> 24) === 0xFD) {
        const vlen = frameLen & 0x00FFFFFF;
        if (buf.length < 4 + vlen) break; // wait for rest of the string
        const version = buf.slice(4, 4 + vlen).toString('utf8');
        buf = buf.slice(4 + vlen);
        if (cam) {
          cam.firmwareVersion = version;
          if (cameraStates[cam.id]) {
            cameraStates[cam.id].firmwareVersion = version;
            saveCameraStates();
          }
          console.log(`[FW] ${cam.id}: version=${version}, latest=${latestFirmwareVersion ?? 'unknown'}`);
          if (latestFirmwareVersion && version !== latestFirmwareVersion && !cam.socket.destroyed) {
            console.log(`[OTA] ${cam.id}: out of date — pushing update automatically`);
            cam.socket.write(CMD_OTA);
          }
          registryEmitter.emit('change');
        }
        continue;
      }

      // Camera ID handshake (first message only): 4-byte length + UTF-8 string
      if (!idReceived) {
        if (frameLen === 0 || frameLen > 64) {
          console.error(`[TCP] Bad ID length ${frameLen} from ${address}, resetting`);
          buf = Buffer.alloc(0);
          break;
        }
        if (buf.length < 4 + frameLen) break; // wait for complete ID
        const payload = buf.slice(4, 4 + frameLen);
        buf = buf.slice(4 + frameLen);
        idReceived = true;
        const id = payload.toString('utf8').replace(/[^a-zA-Z0-9_-]/g, '-');
        registerCamera(id);
        continue;
      }

      // Unknown message after handshake — consume 4 bytes and continue
      buf = buf.slice(4);
    }
  });

  const cleanup = () => {
    if (!cam) return;
    console.log(`[TCP] Camera disconnected: ${address}  id=${cam.id}`);
    cameras.delete(cam.id);
    udpCamMap.delete(cam.udpHash);
    cam.emitter.removeAllListeners();
    clearTimeout(cam.noMotionTimer);
    clearTimeout(cam.manualRecordTimer);
    stopRecording(cam);
    // Keep the camera in cameraStates so it shows as offline in the UI
    registryEmitter.emit('change');
  };

  socket.on('close', cleanup);
  socket.on('error', (err) => {
    console.error(`[TCP] Error from ${address}: ${err.message}`);
    cleanup();
  });
});

tcpServer.listen(TCP_PORT, '::', () =>
  console.log(`[TCP] Listening for cameras on port ${TCP_PORT}`)
);

// ── UDP server — receives fragmented JPEG frames from ESP32 cameras ───────────
// Packet layout (16-byte header + payload):
//   [4] cam_hash   djb2 hash of camera ID
//   [4] frame_seq  monotonic frame counter
//   [2] frag_idx   0-based fragment index
//   [2] frag_total total number of fragments for this frame
//   [4] frame_size total JPEG size in bytes
//   [N] payload    up to 1400 bytes of JPEG data

const UDP_FRAG_STALE_MS = 2_000; // discard incomplete frames after 2 s

// UDP diagnostics
let udpTotalPackets  = 0;
let udpUnknownHash   = 0;
let udpLastStatLog   = Date.now();
const UDP_STAT_INTERVAL_MS = 10_000;

const udpServer = dgram.createSocket('udp6');

udpServer.on('message', (msg, rinfo) => {
  if (msg.length < 16) {
    console.warn(`[UDP] Short packet (${msg.length} B) from ${rinfo.address}:${rinfo.port} — ignored`);
    return;
  }

  udpTotalPackets++;

  // Periodic stats log
  const now = Date.now();
  if (now - udpLastStatLog >= UDP_STAT_INTERVAL_MS) {
    console.log(`[UDP] Stats: ${udpTotalPackets} packets received, ${udpUnknownHash} with unknown hash, ${udpCamMap.size} registered cameras`);
    udpLastStatLog = now;
  }

  const camHash   = msg.readUInt32BE(0);
  const frameSeq  = msg.readUInt32BE(4);
  const fragIdx   = msg.readUInt16BE(8);
  const fragTotal = msg.readUInt16BE(10);
  // frame_size at bytes 12-15 (used for validation only)
  const payload   = msg.slice(16);

  const cam = udpCamMap.get(camHash);
  if (!cam) {
    udpUnknownHash++;
    // Log first unknown packet and then every 50th to avoid flooding
    if (udpUnknownHash === 1 || udpUnknownHash % 50 === 0) {
      const knownHashes = [...udpCamMap.keys()].map(h => `0x${h.toString(16).padStart(8,'0')}`).join(', ');
      console.warn(`[UDP] Unknown camHash 0x${camHash.toString(16).padStart(8,'0')} from ${rinfo.address}:${rinfo.port} (count: ${udpUnknownHash}) — known: [${knownHashes || 'none'}]`);
    }
    return;
  }

  if (!cam.udpFrames.has(frameSeq)) {
    cam.udpFrames.set(frameSeq, {
      frags:    new Array(fragTotal),
      received: 0,
      total:    fragTotal,
      ts:       Date.now(),
    });
  }

  const entry = cam.udpFrames.get(frameSeq);
  if (!entry.frags[fragIdx]) {
    entry.frags[fragIdx] = payload;
    entry.received++;
    if (entry.received === entry.total) {
      cam.udpFrames.delete(frameSeq);
      const frameSize = Buffer.concat(entry.frags).length;
      // Log first frame and then every 100th
      if (!cam._udpFrameCount) cam._udpFrameCount = 0;
      cam._udpFrameCount++;
      if (cam._udpFrameCount === 1) {
        console.log(`[UDP] First frame received from ${cam.id}: seq=${frameSeq} size=${frameSize} B frags=${entry.total}`);
      } else if (cam._udpFrameCount % 100 === 0) {
        console.log(`[UDP] ${cam.id}: frame #${cam._udpFrameCount} seq=${frameSeq} size=${frameSize} B`);
      }
      processFrame(cam, Buffer.concat(entry.frags));
    }
  }
});

udpServer.on('error', (err) => console.error(`[UDP] ${err.message}`));

udpServer.bind(UDP_PORT, '::', () =>
  console.log(`[UDP] Listening for camera frames on port ${UDP_PORT}`)
);

// Unconditional UDP stats — fires every 10 s regardless of whether packets arrive.
// If this line appears but packet count stays 0, packets are not reaching this process.
setInterval(() => {
  console.log(`[UDP] Stats (10s): ${udpTotalPackets} packets received, ${udpUnknownHash} unknown hash, ${udpCamMap.size} registered cameras`);
}, UDP_STAT_INTERVAL_MS);

// Periodically discard stale incomplete UDP frames to prevent memory growth
setInterval(() => {
  const cutoff = Date.now() - UDP_FRAG_STALE_MS;
  for (const cam of cameras.values()) {
    for (const [seq, entry] of cam.udpFrames) {
      if (entry.ts < cutoff) cam.udpFrames.delete(seq);
    }
  }
}, UDP_FRAG_STALE_MS);

// ── HTTP server ───────────────────────────────────────────────────────────────

import cookieParser from 'cookie-parser';
import cors from 'cors';

const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
app.use(cors({
  origin: CORS_ORIGIN,
  credentials: CORS_ORIGIN !== '*',
}));
app.use(express.json());
app.use(cookieParser());

// ── Auth routes (public) ──────────────────────────────────────────────────────

// POST /login  { username, password }
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === AUTH_USER && password === AUTH_PASS) {
    const token = signToken();
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000, // 24 h
    });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

// POST /logout
app.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// GET /healthz — unauthenticated liveness probe for Docker / load-balancers
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// GET /me — frontend uses this to check if the cookie is still valid on load
app.get('/me', requireAuth, (_req, res) => res.json({ ok: true }));

// ── Settings routes (authenticated) ──────────────────────────────────────────

app.get('/settings', requireAuth, (_req, res) => res.json(settings));

app.put('/settings', requireAuth, (req, res) => {
  const { motionEnabled, noMotionSecs } = req.body || {};

  if (typeof motionEnabled === 'boolean') {
    settings.motionEnabled = motionEnabled;
    // If fps-reduction just got disabled, cancel any pending standby timers
    // and ensure every connected camera is in active mode
    if (!motionEnabled) {
      for (const cam of cameras.values()) {
        clearTimeout(cam.noMotionTimer);
        cam.noMotionTimer = null;
        cam.isActive = true;
        if (!cam.socket.destroyed) cam.socket.write(CMD_ACTIVE);
      }
    }
  }

  if (typeof noMotionSecs === 'number' && noMotionSecs >= 1 && noMotionSecs <= 3600) {
    settings.noMotionSecs = Math.round(noMotionSecs);
  }

  if (typeof req.body.recordingEnabled === 'boolean') {
    settings.recordingEnabled = req.body.recordingEnabled;
    // If recording just got disabled, stop all active recordings
    if (!settings.recordingEnabled) {
      for (const cam of cameras.values()) stopRecording(cam);
    }
  }

  if (typeof req.body.recordOnBell === 'boolean') {
    settings.recordOnBell = req.body.recordOnBell;
  }

  if (typeof req.body.maxStorageGB === 'number' && req.body.maxStorageGB >= 1) {
    settings.maxStorageGB = req.body.maxStorageGB;
  }

  if (typeof req.body.manualRecordMins === 'number' && req.body.manualRecordMins >= 1) {
    settings.manualRecordMins = Math.round(req.body.manualRecordMins);
  }

  if (typeof req.body.timezone === 'string') {
    try {
      // Validate the timezone string — Intl will throw on unknown zones
      Intl.DateTimeFormat(undefined, { timeZone: req.body.timezone });
      settings.timezone = req.body.timezone;
    } catch {
      return res.status(400).json({ error: 'Invalid timezone' });
    }
  }

  res.json(settings);
  saveSettings();
});

// ── Camera name routes (authenticated) ───────────────────────────────────────

// PUT /cameras/:id/sleep  { enabled: bool }
app.put('/cameras/:id/sleep', requireAuth, (req, res) => {
  const { id } = req.params;
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });

  if (!cameraStates[id]) cameraStates[id] = {};
  cameraStates[id].sleepEnabled = enabled;
  saveCameraStates();

  // If the camera is currently connected and we're enabling sleep, command it now
  const cam = cameras.get(id);
  if (cam && enabled && !cam.socket.destroyed) {
    console.log(`[Sleep] ${id}: toggled on via UI → sending CMD_SLEEP`);
    cam.socket.write(CMD_SLEEP);
  }

  registryEmitter.emit('change');
  res.json({ ok: true });
});

// PUT /cameras/:id/framesize  { frameSize: 'SXGA'|'UXGA'|'FHD'|'QXGA' }
app.put('/cameras/:id/framesize', requireAuth, (req, res) => {
  const { id } = req.params;
  const { frameSize } = req.body || {};
  if (!FRAMESIZES[frameSize]) {
    return res.status(400).json({ error: `Invalid frameSize. Valid values: ${Object.keys(FRAMESIZES).join(', ')}` });
  }

  if (!cameraStates[id]) cameraStates[id] = {};
  cameraStates[id].frameSize = frameSize;
  saveCameraStates();

  const cam = cameras.get(id);
  if (cam) {
    cam.frameSize = frameSize;
    if (!cam.socket.destroyed) {
      console.log(`[FrameSize] ${id}: changing to ${frameSize} via UI`);
      cam.socket.write(FRAMESIZES[frameSize].cmd);
    }
  }

  registryEmitter.emit('change');
  res.json({ ok: true, frameSize });
});

// POST /ota/push-all — internal endpoint called by the OTA server when firmware.bin changes.
// Not protected by cookie auth; instead uses a shared secret header so only the
// OTA server (same Docker network / localhost) can call it.
const OTA_SECRET = process.env.OTA_SECRET || '';
app.post('/ota/push-all', (req, res) => {
  if (OTA_SECRET && req.headers['x-ota-secret'] !== OTA_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { version } = req.body || {};
  if (version && version !== latestFirmwareVersion) {
    latestFirmwareVersion = version;
    saveOtaState();
    console.log(`[OTA] Latest firmware version set to: ${version}`);
  }
  let pushed = 0, skipped = 0;
  for (const [id, cam] of cameras) {
    if (!cam.socket.destroyed) {
      if (version && cam.firmwareVersion === version) {
        console.log(`[OTA] ${id}: already on ${version} — skipping`);
        skipped++;
        continue;
      }
      console.log(`[OTA] Auto-pushing firmware update to ${id}`);
      cam.socket.write(CMD_OTA);
      pushed++;
    }
  }
  console.log(`[OTA] Pushed to ${pushed} camera(s), skipped ${skipped} (already up to date)`);
  registryEmitter.emit('change');
  res.json({ ok: true, pushed, skipped });
});

// GET /ota/version — returns the firmware version currently tracked by the backend,
// and optionally proxies to the OTA server for a live confirmation.
app.get('/ota/version', requireAuth, async (_req, res) => {
  let otaLive = null;
  try {
    const r = await fetch(`http://${OTA_HOST}/healthz`, { signal: AbortSignal.timeout(2000) });
    otaLive = (await r.json()).version ?? null;
  } catch { /* OTA server unreachable — return cached value only */ }
  res.json({ version: latestFirmwareVersion, otaLive });
});

// POST /cameras/:id/ota — push firmware update to a connected camera
// The camera downloads firmware.bin from the OTA server (port 9002) and reboots.
app.post('/cameras/:id/ota', requireAuth, (req, res) => {
  const { id } = req.params;
  const cam = cameras.get(id);
  if (!cam) return res.status(404).json({ error: 'Camera not connected' });
  if (cam.socket.destroyed) return res.status(409).json({ error: 'Camera socket is closed' });

  console.log(`[OTA] Sending update command to ${id}`);
  cam.socket.write(CMD_OTA);
  res.json({ ok: true, message: 'OTA command sent — camera will reboot after flashing' });
});

// DELETE /cameras/:id — forget an offline camera entirely
app.delete('/cameras/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (cameras.has(id)) return res.status(409).json({ error: 'Camera is currently connected' });
  delete cameraStates[id];
  saveCameraStates();
  registryEmitter.emit('change');
  res.json({ ok: true });
});

// PUT /cameras/:id/name  { name: string }
app.put('/cameras/:id/name', requireAuth, (req, res) => {
  const { id } = req.params;
  const { name } = req.body || {};
  if (typeof name !== 'string') return res.status(400).json({ error: 'name must be a string' });
  const trimmed = name.trim().slice(0, 64);
  if (!cameraStates[id]) cameraStates[id] = {};
  if (trimmed) {
    cameraStates[id].name = trimmed;
  } else {
    delete cameraStates[id].name;
  }
  saveCameraStates();
  registryEmitter.emit('change');
  res.json({ ok: true, name: cameraStates[id]?.name || null });
});

// ── Manual recording routes (authenticated) ───────────────────────────────────

app.post('/record/:id/start', requireAuth, (req, res) => {
  const cam = cameras.get(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });
  if (cam.recorder) return res.status(409).json({ error: 'Already recording' });
  startRecording(cam, true);
  res.json({ ok: true });
});

app.post('/record/:id/stop', requireAuth, (req, res) => {
  const cam = cameras.get(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });
  stopRecording(cam);
  res.json({ ok: true });
});

// ── Recordings management routes (authenticated) ─────────────────────────────

function probeDuration(fp) {
  try {
    const r = spawnSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      fp,
    ]);
    const val = parseFloat(r.stdout?.toString().trim());
    return isFinite(val) ? val : null;
  } catch { return null; }
}

// List all recordings grouped by camera id
app.get('/recordings', requireAuth, (req, res) => {
  // Collect paths currently being written so we can exclude them
  const activePaths = new Set(
    [...cameras.values()]
      .filter(c => c.recorder?.path)
      .map(c => path.normalize(c.recorder.path).toLowerCase())
  );

  const result = {};
  try {
    const entries = fs.readdirSync(RECORDINGS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const camId = entry.name;
      const camDir = path.join(RECORDINGS_DIR, camId);
      try {
        const files = fs.readdirSync(camDir)
          .filter(f => f.endsWith('.mp4'))
          .map(f => {
            const fp = path.join(camDir, f);
            const st = fs.statSync(fp);
            return { name: f, size: st.size, mtime: st.mtimeMs, fp };
          })
          .filter(f => !activePaths.has(path.normalize(f.fp).toLowerCase()))
          .map(({ name, size, mtime, fp }) => ({ name, size, mtime, duration: probeDuration(fp) }))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length > 0) result[camId] = files;
      } catch { /* skip unreadable dirs */ }
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json(result);
});

// Stream a recording file for in-browser playback (supports range requests)
app.get('/recordings/:camId/:file', requireAuth, (req, res) => {
  const { camId, file } = req.params;
  // Prevent path traversal
  if (camId.includes('..') || camId.includes('/') || file.includes('..') || file.includes('/')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  if (!file.endsWith('.mp4')) return res.status(400).json({ error: 'Invalid file type' });
  const fp = path.join(RECORDINGS_DIR, camId, file);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });

  const stat = fs.statSync(fp);
  const total = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    const chunkSize = end - start + 1;
    const stream = fs.createReadStream(fp, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(fp).pipe(res);
  }
});

// Thumbnail — extract a single frame at ~25% duration
app.get('/recordings/:camId/:file/thumb', requireAuth, (req, res) => {
  const { camId, file } = req.params;
  if (camId.includes('..') || camId.includes('/') || file.includes('..') || file.includes('/')) {
    return res.status(400).end();
  }
  if (!file.endsWith('.mp4')) return res.status(400).end();
  const fp = path.join(RECORDINGS_DIR, camId, file);
  if (!fs.existsSync(fp)) return res.status(404).end();

  // Get duration first
  let seekTime = 5;
  try {
    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', fp,
    ]);
    const dur = parseFloat(probe.stdout?.toString().trim());
    if (isFinite(dur) && dur > 0) seekTime = Math.min(dur * 0.25, dur - 0.1);
  } catch { /* use default */ }

  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'max-age=3600');

  const ff = spawn('ffmpeg', [
    '-ss', String(seekTime),
    '-i', fp,
    '-frames:v', '1',
    '-f', 'image2',
    '-vcodec', 'mjpeg',
    'pipe:1',
  ]);
  ff.stdout.pipe(res);
  ff.stderr.resume(); // discard stderr
  ff.on('error', () => res.status(500).end());
});

// Download a recording file as attachment
app.get('/recordings/:camId/:file/download', requireAuth, (req, res) => {
  const { camId, file } = req.params;
  if (camId.includes('..') || camId.includes('/') || file.includes('..') || file.includes('/')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  if (!file.endsWith('.mp4')) return res.status(400).json({ error: 'Invalid file type' });
  const fp = path.join(RECORDINGS_DIR, camId, file);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.download(fp, file);
});

// Delete a recording file
app.delete('/recordings/:camId/:file', requireAuth, (req, res) => {
  const { camId, file } = req.params;
  if (camId.includes('..') || camId.includes('/') || file.includes('..') || file.includes('/')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  if (!file.endsWith('.mp4')) return res.status(400).json({ error: 'Invalid file type' });
  const fp = path.join(RECORDINGS_DIR, camId, file);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  try {
    fs.unlinkSync(fp);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// MJPEG stream for a specific camera
app.get('/stream/:id', requireAuth, (req, res) => {
  const cam = cameras.get(req.params.id);
  if (!cam) return res.status(404).end();

  res.writeHead(200, {
    'Content-Type':  `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control': 'no-cache, no-store',
    'Connection':    'keep-alive',
    'Pragma':        'no-cache',
  });

  const writeFrame = (frame) => {
    try {
      res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      res.write(frame);
      res.write('\r\n');
    } catch { /* client disconnected */ }
  };

  if (cam.latestFrame) writeFrame(cam.latestFrame);
  cam.emitter.on('frame', writeFrame);
  req.on('close', () => cam.emitter.off('frame', writeFrame));
});

// SSE endpoint — pushes camera list to the frontend instantly on connect/disconnect
app.get('/events', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });

  const send = () => {
    res.write(`data: ${JSON.stringify(cameraList())}\n\n`);
  };

  send(); // current state immediately
  registryEmitter.on('change', send);

  // Push fps updates every 2 s so the counter stays live without needing a state change
  const fpsInterval = setInterval(() => {
    try { send(); } catch { /* client gone */ }
  }, 2_000);

  // Heartbeat: keep the connection alive and let the browser detect drops fast
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* client gone */ }
  }, 5_000);

  req.on('close', () => {
    clearInterval(fpsInterval);
    clearInterval(heartbeat);
    registryEmitter.off('change', send);
  });
});

// SSE endpoint — pushes bell events when a camera button is pressed
app.get('/bell-events', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });

  const onBell = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
  };

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* client gone */ }
  }, 5_000);

  bellEmitter.on('bell', onBell);
  req.on('close', () => {
    clearInterval(heartbeat);
    bellEmitter.off('bell', onBell);
  });
});

app.listen(HTTP_PORT, '0.0.0.0', () =>
  console.log(`[HTTP] Backend running on http://0.0.0.0:${HTTP_PORT}`)
);

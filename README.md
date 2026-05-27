# PortalView

A self-hosted, multi-camera video surveillance system built for **Seeed XIAO ESP32-S3 Sense** cameras. PortalView streams live MJPEG video from one or more battery-powered cameras to a React web interface, with motion-triggered recording, bell-button alerts, and remote per-camera controls — all running behind a single Node.js backend.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Components](#components)
   - [CameraClient (ESP32-S3 Firmware)](#cameraclient-esp32-s3-firmware)
   - [Backend (Node.js)](#backend-nodejs)
   - [Frontend (React)](#frontend-react)
3. [Network Protocol](#network-protocol)
   - [TCP Control Channel](#tcp-control-channel)
   - [UDP Video Channel](#udp-video-channel)
   - [HTTP / SSE API](#http--sse-api)
4. [Authentication](#authentication)
5. [Camera Lifecycle](#camera-lifecycle)
6. [Motion Detection](#motion-detection)
7. [Video Recording](#video-recording)
8. [Camera Controls](#camera-controls)
9. [Bell Button](#bell-button)
10. [Deep Sleep Mode](#deep-sleep-mode)
11. [Persistent State](#persistent-state)
12. [Frontend Features](#frontend-features)
13. [Configuration Reference](#configuration-reference)
14. [Deployment (Docker)](#deployment-docker)
15. [Development Setup](#development-setup)
16. [API Reference](#api-reference)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Local Network / Internet                    │
│                                                                     │
│   ┌─────────────────┐   TCP :9000 (control)   ┌─────────────────┐  │
│   │  ESP32-S3 Cam 1 │ ──────────────────────► │                 │  │
│   │  (CameraClient) │   UDP :9001 (frames)    │   Backend       │  │
│   └─────────────────┘ ──────────────────────► │   Node.js       │  │
│                                               │   Express       │  │
│   ┌─────────────────┐   TCP :9000             │                 │  │
│   │  ESP32-S3 Cam 2 │ ──────────────────────► │  HTTP :3001     │  │
│   │  (CameraClient) │   UDP :9001             │  (REST + SSE    │  │
│   └─────────────────┘ ──────────────────────► │   + MJPEG)      │  │
│                                               └────────┬────────┘  │
│                                                        │            │
│                                               ┌────────▼────────┐  │
│                                               │   Frontend      │  │
│                                               │   React / Vite  │  │
│                                               │   :5173 / :80   │  │
│                                               └─────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

Each camera maintains **two simultaneous connections** to the backend:

| Channel | Transport | Purpose |
|---------|-----------|---------|
| Control | TCP | Camera registration, heartbeats, battery reports, button presses, command delivery |
| Video   | UDP | Fragmented JPEG frame stream |

The frontend connects only to the backend over HTTP/SSE — it never talks to cameras directly.

---

## Components

### CameraClient (ESP32-S3 Firmware)

**Location:** `CameraClient/CameraClient.ino`  
**Hardware:** Seeed XIAO ESP32-S3 Sense (OV5640 image sensor, PSRAM required)  
**Framework:** Arduino (ESP-IDF via arduino-esp32)

The firmware handles:
- Connecting to Wi-Fi and the backend TCP/UDP servers
- Sending a unique ID derived from the MAC address on each connection
- Capturing JPEG frames from the OV5640 sensor and sending them via UDP
- Receiving single-byte commands from the backend over TCP
- Reporting battery percentage, heartbeats, and button presses
- Entering ESP32 deep sleep on command or when battery is critically low

#### Camera ID

Each camera generates a stable unique identifier from its MAC address:

```
CAM-AABBCCDDEEFF
```

This ID is sent as the first message on every TCP connection and is used as the primary key throughout the system.

---

### Backend (Node.js)

**Location:** `backend/server.js`  
**Runtime:** Node.js 22 (ESM)  
**Key dependencies:** `express`, `jsonwebtoken`, `jpeg-js`, `sharp`, `motion-detect`

The backend is the system's hub. It:
- Accepts TCP connections from cameras and manages their lifecycle
- Receives UDP fragmented JPEG frames and reassembles them
- Serves MJPEG streams to the frontend over HTTP
- Pushes real-time camera list updates to the frontend via Server-Sent Events (SSE)
- Runs per-camera motion detection on incoming frames
- Drives FFmpeg to record motion-triggered or manual MP4 files
- Persists camera state (name, sleep setting, battery, frame size, JPEG quality) across restarts
- Exposes a REST API for the frontend to query and control cameras

---

### Frontend (React)

**Location:** `frontend/`  
**Build tool:** Vite 5  
**Key dependency:** `@websr/websr` (WebGPU super-resolution)

The frontend is a single-page React application that:
- Shows a live grid of all cameras (connected and offline)
- Streams MJPEG video from each camera
- Uses WebGPU-based super-resolution upscaling (WebSR) in the expanded view when the GPU supports it, falling back to a plain `<img>` tag
- Subscribes to SSE for real-time camera list changes
- Displays bell-button alerts with auto-dismiss
- Provides per-camera controls (recording, sleep, frame size, JPEG quality, rename)
- Includes a recordings manager with in-browser playback, download, and delete
- Has a settings panel for global motion detection and recording configuration

---

## Network Protocol

### TCP Control Channel

**Default port:** `9000` (configurable via `TCP_PORT`)

Each ESP32 camera opens a persistent TCP connection. The backend wraps a Node.js `net.createServer` socket. Both sides listen on IPv6 (`::`) which also accepts IPv4-mapped addresses.

#### Message framing

All TCP messages use a **4-byte big-endian header** followed by an optional payload. The top byte of the header identifies the message type when it holds a sentinel value; otherwise the full 32-bit value is the payload length.

| Top byte | Meaning | Payload |
|----------|---------|---------|
| `0x00`–`0x7F` (normal) | **Camera ID handshake** (first message only) | UTF-8 camera ID string, `header` bytes long |
| `0xFF` | **Battery report** | None — low byte of header = percentage (0–100) |
| `0xFE` | **Heartbeat** | None — resets the 15 s idle timeout |
| `0xFD` | **Firmware version** | UTF-8 version string, lower 3 bytes of header = length |
| `0xFC` | **Button press** | None |

#### Backend → Camera commands (1 byte)

| Byte | Constant | Effect |
|------|----------|--------|
| `0x00` | `CMD_STANDBY` | Enter standby: send one frame per second |
| `0x01` | `CMD_ACTIVE` | Enter active mode: send frames at full rate |
| `0x02` | `CMD_SLEEP` | Enter ESP32 deep sleep (1 min timer + button wakeup) |
| `0x03` | — | Set frame size to SXGA (1280×1024) |
| `0x04` | — | Set frame size to UXGA (1600×1200) |
| `0x05` | — | Set frame size to FHD (1920×1080) |
| `0x06` | — | Set frame size to QXGA (2048×1536) |
| `0x10` | `CMD_OTA` | Initiate OTA firmware update |
| `0x20 <raw>` | — | Set JPEG quality; second byte is raw ESP32 quality (0–63, lower = better) |

#### Idle timeout

The backend configures a **15-second idle timeout** on each socket. The firmware sends a heartbeat every 5 seconds, so up to 3 missed heartbeats are tolerated before the connection is closed and the camera is marked offline.

---

### UDP Video Channel

**Default port:** `9001` (configurable via `UDP_PORT`)

JPEG frames are sent over UDP because TCP's reliability and head-of-line blocking would cause unbearable latency on a live video stream. Large frames are split into fragments of up to **1400 bytes** each to stay under typical MTU limits.

#### Packet layout

Each UDP packet has a **16-byte header** followed by up to 1400 bytes of raw JPEG data:

```
Offset  Size  Field
------  ----  -----
     0     4  cam_hash    — djb2 hash of the camera ID string
     4     4  frame_seq   — monotonic frame counter (uint32)
     8     2  frag_idx    — 0-based index of this fragment
    10     2  frag_total  — total number of fragments for this frame
    12     4  frame_size  — total JPEG size in bytes (all fragments combined)
    16     N  payload     — JPEG data slice (N ≤ 1400)
```

#### djb2 hash routing

The backend keeps a `Map<hash → cam>` (`udpCamMap`) for O(1) packet-to-camera routing without a string lookup per packet. Both the firmware and the backend implement the same djb2 hash:

```
hash = 5381
for each char c: hash = ((hash << 5) + hash) + c   [unsigned 32-bit]
```

#### Reassembly

The backend accumulates fragments in `cam.udpFrames` keyed by `frame_seq`. When `received === total` the fragments are concatenated in order and dispatched to `processFrame()`. Incomplete frames older than **2 seconds** are discarded to prevent memory growth.

#### Why IPv6

The backend binds the UDP socket to `::` (IPv6 any-address). The firmware resolves the server hostname with `AI_V4MAPPED | AI_ADDRCONFIG` and uses raw lwIP POSIX sockets (`AF_INET6 SOCK_DGRAM`) directly, because `WiFiUDP` only creates `AF_INET` sockets and silently drops packets destined for IPv6 addresses. IPv4-mapped addresses (e.g. `::ffff:192.168.0.1`) allow the same socket to accept connections from both IPv4 and IPv6 cameras.

---

### HTTP / SSE API

**Default port:** `3001` (configurable via `HTTP_PORT`)

All routes under the authenticated namespace require a valid JWT cookie (`pv_token`). The frontend proxies all API calls through Vite's dev server during development, so no CORS configuration is needed there.

#### Server-Sent Events

**`GET /events`** — pushes a `text/event-stream` response that emits the full camera list as a JSON array whenever any camera connects, disconnects, or its state changes. The frontend subscribes on login and reconnects with exponential back-off (1 s → 30 s) on error.

**`GET /bell-events`** — pushes bell-button press notifications: `{ id, name }`. The frontend auto-dismisses alerts after 8 seconds.

#### MJPEG stream

**`GET /stream/:id`** — streams a `multipart/x-mixed-replace; boundary=mjpegboundary` response. Each part contains one JPEG frame as `image/jpeg` with a `Content-Length` header. The backend emits frames directly from the camera's `EventEmitter` into the response, so latency is minimal. Supports multiple concurrent viewers per camera (each gets their own SSE-style pipe).

---

## Authentication

Authentication uses **JWT tokens stored in an HttpOnly, SameSite=strict cookie** named `pv_token`.

| Env var | Default | Purpose |
|---------|---------|---------|
| `PV_USER` | `admin` | Login username |
| `PV_PASS` | `portalview` | Login password |
| `JWT_SECRET` | random 32-byte hex on each start | JWT signing secret |

> **Production note:** Set `JWT_SECRET` to a long, random, persistent value so existing sessions survive backend restarts.

Tokens expire after **24 hours**. The frontend checks `/me` on load to determine whether the stored cookie is still valid, avoiding a full login page flash.

The login endpoint (`POST /login`) accepts `{ username, password }` in JSON, validates credentials with a constant-time-equivalent comparison, and sets the cookie. Logout (`POST /logout`) clears the cookie server-side.

---

## Camera Lifecycle

```
Camera boots
  │
  ├─ connects TCP
  │    └─ sends: camera ID
  │    └─ sends: battery percentage
  │    └─ sends: firmware version
  │
  ├─ backend registers camera in `cameras` Map
  │    └─ restores persistent state (frame size, quality, sleep flag)
  │    └─ sends CMD_SLEEP if sleep is enabled  — or —
  │    └─ sends frame size command + quality command
  │
  ├─ camera starts streaming frames via UDP
  │    └─ starts in standby mode (1 fps)
  │    └─ server sends CMD_ACTIVE on motion detection
  │
  ├─ sends heartbeat every 5 s (keeps TCP alive)
  ├─ sends battery every 5 min
  │
  └─ TCP disconnect
       └─ backend removes from `cameras` Map
       └─ camera shown as offline in UI (retains last known state)
```

---

## Motion Detection

The backend runs a lightweight per-camera motion detector using the `motion-detect` library.

**How it works:**

1. Every incoming JPEG frame is decoded to raw RGBA pixels using `jpeg-js`.
2. The image is **subsampled by a factor of 8** (every 8th pixel in both axes) to reduce CPU load on high-resolution frames (e.g. QXGA 2048×1536 → 256×192 analysis grid).
3. Motion detection analysis runs at most once every **500 ms** per camera to further limit CPU use.
4. If motion is detected:
   - The camera is commanded to `CMD_ACTIVE` (full framerate) if `motionEnabled` is on.
   - Recording starts if `recordingEnabled` is on and the camera is not already recording.
   - A `noMotionSecs` countdown timer is reset.
5. When the countdown expires with no new motion:
   - The camera is commanded back to `CMD_STANDBY` if `motionEnabled` is on.
   - The recording stops if `recordingEnabled` is on.

All thresholds are runtime-configurable via the settings API without restarting the backend.

---

## Video Recording

Recording is driven by **FFmpeg** spawned as a child process per camera.

### Encoding

The backend detects available hardware encoders at startup with priority:

1. `h264_nvenc` (NVIDIA GPU)
2. `h264_qsv` (Intel QuickSync)
3. `libx264` (CPU fallback, preset `ultrafast`)

### Frame pipeline

```
UDP frame reassembly
  └─ processFrame()
       └─ writeRecordingFrame()
            └─ stampFrame()   — composites IP/name + timestamp overlay via sharp/SVG
            └─ ffmpeg stdin   — receives stamped JPEG; produces fragmented MP4
```

Recordings are **fragmented MP4** (`+frag_keyframe+empty_moov+default_base_moof`) which allows in-browser seeking without requiring a complete file.

### Timestamp overlay

`stampFrame()` uses `sharp` to composite an SVG overlay onto each frame before encoding:
- Top line: camera name (or ID) + IP address + date/time
- Bottom line: timezone string

The timestamp is formatted in the configured timezone using `Intl.DateTimeFormat`.

### Auto-split

Each recording file is automatically split every **10 minutes** to keep individual files manageable. A new file starts immediately after the split.

### Storage quota

Before starting any new recording, `enforceStorageQuota()` walks all recordings, sorts by modification time (oldest first), and deletes files until total usage is at or below `maxStorageGB`.

### Manual recording

A recording can be started manually from the UI regardless of motion state. Manual recordings:
- Keep the camera at full framerate for their duration
- Auto-stop after `manualRecordMins` minutes
- Are not affected by motion detection standby transitions

### File layout

```
backend/recordings/
  <camera-id>/
    2024-01-15T10-30-00-000Z.mp4
    2024-01-15T10-40-00-000Z.mp4
    ...
```

---

## Camera Controls

All controls are per-camera and persist across camera reboots via `camera-states.json`.

| Control | API | Effect |
|---------|-----|--------|
| **Rename** | `PUT /cameras/:id/name` | Sets a human-readable display name |
| **Frame size** | `PUT /cameras/:id/framesize` | Changes sensor output resolution; sent as a 1-byte command |
| **JPEG quality** | `PUT /cameras/:id/quality` | User-facing 25–95 %; mapped to ESP32 raw 0–63 (inverted) |
| **Sleep** | `PUT /cameras/:id/sleep` | Enables/disables deep sleep mode; immediately sleeps if toggled on |
| **Manual record start** | `POST /record/:id/start` | Begins a manual recording session |
| **Manual record stop** | `POST /record/:id/stop` | Ends the current manual session |
| **Delete (offline)** | `DELETE /cameras/:id` | Removes an offline camera from the known-camera registry |

#### Quality mapping

The user sees a percentage (25–95 %). The ESP32 uses an inverted raw scale (0 = best quality, 63 = worst). Conversion:

```
rawQuality = round((1 - pct / 100) × 63)
```

The command is sent as two bytes: `[0x20, rawQuality]`.

---

## Bell Button

The firmware listens on GPIO pin **D3**. When pressed, it sends a `0xFC` sentinel over TCP to the backend.

The backend:
1. Emits a `bell` event on `bellEmitter` with `{ id, name }`.
2. Optionally starts a manual recording if `recordOnBell` is enabled in settings.
3. Pushes the event to all SSE clients connected to `/bell-events`.

The frontend displays a dismissible alert overlay that auto-clears after **8 seconds**.

The button also serves as a **deep sleep wakeup source** via `esp_sleep_enable_ext1_wakeup`, triggered on `ANY_LOW`.

---

## Deep Sleep Mode

When sleep is enabled for a camera (via the UI), the backend sends `CMD_SLEEP` (`0x02`) immediately after the ID handshake. The ESP32 then:

1. Disconnects TCP and Wi-Fi.
2. Calls `esp_deep_sleep_start()` with a **1-minute timer wakeup**.
3. Also configures ext1 wakeup on the button pin (D3) so the camera wakes immediately on button press.

On each wake cycle the camera reconnects, performs the full handshake, and the backend immediately commands sleep again if the flag is still set.

Sleep mode is intended for battery conservation when a camera location needs only periodic check-ins or doorbell-style on-demand wakeup.

---

## Persistent State

The backend writes two JSON files to disk:

### `camera-states.json`

Stores per-camera state that must survive backend restarts:

```json
{
  "CAM-AABBCCDDEEFF": {
    "name": "Front Door",
    "sleepEnabled": false,
    "battery": 87,
    "frameSize": "QXGA",
    "jpegQuality": 75,
    "firmwareVersion": "1.0.3"
  }
}
```

Written on every change that modifies any field. Offline cameras remain in this file so they appear as "offline" in the UI with their last-known state.

### `settings.json`

Stores global backend settings:

```json
{
  "motionEnabled": true,
  "noMotionSecs": 180,
  "recordingEnabled": true,
  "recordOnBell": false,
  "maxStorageGB": 10,
  "manualRecordMins": 30,
  "timezone": "Europe/Prague"
}
```

---

## Frontend Features

### Camera grid

The main view shows a responsive grid of camera tiles. Each tile displays:
- Live MJPEG stream (or an offline indicator)
- Camera name / ID (click to rename inline)
- Recording status badge with elapsed time
- Battery percentage
- Live FPS counter (calculated from a rolling 15-frame window, 2 s stale threshold)
- Frame size selector (SXGA / UXGA / FHD / QXGA)
- JPEG quality slider (debounced 300 ms)
- Sleep toggle
- Record button

### Expanded view (OverlayViewer)

Clicking a tile opens a full-screen expanded view that uses **WebSR** — a WebGPU-based super-resolution upscaler — to render the MJPEG stream at higher visual quality. The component:

1. Parses the `multipart/x-mixed-replace` MJPEG stream manually using a `ReadableStream` reader, extracting individual JPEG `Blob` objects from the multipart boundary.
2. Creates `ImageBitmap` objects from each blob (avoids cross-origin canvas taint).
3. Passes bitmaps to the WebSR WebGPU pipeline in a `requestAnimationFrame` loop.
4. Falls back to a plain `<img>` element if WebGPU is unavailable.

### Recordings Manager

- Lists all recordings grouped by camera, sorted newest first.
- Shows file name, size, modification date, and duration (via `ffprobe`).
- Supports in-browser playback using a `<video>` element with range-request streaming (`GET /recordings/:camId/:file`).
- Supports file download.
- Supports per-file delete with a confirmation dialog.
- Excludes files currently being written to.

### Settings panel

Runtime-editable global settings:
- **Motion detection** — enable/disable FPS reduction on no-motion
- **Active duration after motion** — seconds before returning to standby
- **Motion-triggered recording** — enable/disable automatic recording
- **Record on bell** — start a recording on button press
- **Max storage** — quota in GB (oldest files deleted when exceeded)
- **Manual record duration** — auto-stop timer for manual recordings
- **Timezone** — for recording timestamp overlays

### SSE reconnection

The frontend connects to `/events` and `/bell-events` using `EventSource`. On connection error, it closes the source and retries with exponential back-off starting at 1 second, capped at 30 seconds. On successful message, back-off resets to 1 second.

### UI scale

A global zoom factor is saved in `localStorage` (`uiScale`) and applied via CSS `zoom`. This lets users adapt the interface to their display density.

---

## Configuration Reference

### Backend environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TCP_PORT` | `9000` | TCP port for camera control connections |
| `UDP_PORT` | `9001` | UDP port for camera video frames |
| `HTTP_PORT` | `3001` | HTTP port for the REST/SSE/MJPEG API |
| `PV_USER` | `admin` | Login username |
| `PV_PASS` | `portalview` | Login password |
| `JWT_SECRET` | random | JWT signing secret — **set in production** |
| `CORS_ORIGIN` | `*` | Allowed CORS origin; set credentials mode when not `*` |
| `OTA_HOST` | `localhost` | Hostname of the OTA firmware server |
| `OTA_SECRET` | _(empty)_ | Shared secret for `/ota/push-all` internal endpoint |

### Frontend environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_BASE_URL` | _(empty)_ | Backend base URL for production deployments |
| `BACKEND_HOST` | `localhost` | Backend host for Vite dev proxy |
| `BACKEND_PORT` | `3001` | Backend port for Vite dev proxy |
| `PRODUCTION` | _(unset)_ | If set, proxy target omits port (uses port 80) |
| `VITE_ALLOWED_HOSTS` | _(empty)_ | Comma-separated allowed hosts for Vite dev server |
| `VITE_PORT` | `5173` | Vite dev server port |

### Firmware compile-time defines (`CameraClient.ino`)

| Define | Effect |
|--------|--------|
| `PRODUCTION_ENVIRONMENT 1` | Uses production Wi-Fi credentials and server hostnames |
| `IGNORE_BATTERY_PERCENTAGE 1` | Treats battery as always full (useful for USB-powered cameras) |
| `BUTTON_PIN D3` | GPIO pin for bell button |
| `BUZZER_PIN D2` | GPIO pin for buzzer (reserved) |

---

## Deployment (Docker)

Each component ships with a `Dockerfile`.

### Backend

```dockerfile
FROM node:22-slim
# Installs ffmpeg (for recording) and imagemagick
```

Exposed ports: `HTTP_PORT` (default 3001), `TCP_PORT` (default 9000), `UDP_PORT` (default 9001).

Health check: `GET /healthz` (unauthenticated, returns `{ ok: true }`).

### Frontend

```dockerfile
FROM node:22-slim
```

Exposed port: `80`.

Health check: `GET /` returning HTTP 200.

### Example `docker-compose.yml` sketch

```yaml
services:
  backend:
    build: ./backend
    ports:
      - "3001:3001"   # HTTP API
      - "9000:9000"   # TCP cameras
      - "9001:9001/udp"  # UDP frames
    environment:
      PV_PASS: changeme
      JWT_SECRET: your-long-random-secret
    volumes:
      - ./backend/recordings:/app/recordings
      - ./backend/camera-states.json:/app/camera-states.json
      - ./backend/settings.json:/app/settings.json

  frontend:
    build: ./frontend
    ports:
      - "80:80"
    environment:
      BACKEND_HOST: backend
      BACKEND_PORT: "3001"
      PRODUCTION: "1"
```

---

## Development Setup

### Backend

```bash
cd backend
npm install
# Optional: create a .env file
# PV_USER=admin
# PV_PASS=portalview
npm run dev      # node --watch server.js
```

Requires **FFmpeg** on PATH for recording support.

### Frontend

```bash
cd frontend
npm install
npm run dev      # vite --host, proxies API calls to localhost:3001
```

The Vite dev proxy forwards the following paths to the backend:

`/stream`, `/events`, `/login`, `/logout`, `/me`, `/settings`, `/cameras`, `/record`, `/recordings`, `/healthz`

### Firmware

1. Open `CameraClient/CameraClient.ino` in Arduino IDE or VS Code with the Arduino extension.
2. Select board: **XIAO_ESP32S3**.
3. Set `PRODUCTION_ENVIRONMENT 0` for local development.
4. Update `ssid`, `password`, and `serverHost` / `otaHost` as needed.
5. Flash via USB.

---

## API Reference

All routes except `/login`, `/logout`, `/healthz` require the `pv_token` cookie.

### Auth

| Method | Path | Body | Response |
|--------|------|------|----------|
| `POST` | `/login` | `{ username, password }` | `{ ok: true }` + sets cookie |
| `POST` | `/logout` | — | `{ ok: true }` + clears cookie |
| `GET` | `/me` | — | `{ ok: true }` or 401 |
| `GET` | `/healthz` | — | `{ ok: true }` (unauthenticated) |

### Cameras

| Method | Path | Body | Response |
|--------|------|------|----------|
| `GET` | `/events` | — | SSE stream of camera list arrays |
| `GET` | `/bell-events` | — | SSE stream of `{ id, name }` bell events |
| `GET` | `/stream/:id` | — | `multipart/x-mixed-replace` MJPEG stream |
| `PUT` | `/cameras/:id/name` | `{ name: string }` | `{ ok, name }` |
| `PUT` | `/cameras/:id/sleep` | `{ enabled: boolean }` | `{ ok }` |
| `PUT` | `/cameras/:id/framesize` | `{ frameSize: 'SXGA'|'UXGA'|'FHD'|'QXGA' }` | `{ ok, frameSize }` |
| `PUT` | `/cameras/:id/quality` | `{ quality: 25..95 }` | `{ ok, quality }` |
| `DELETE` | `/cameras/:id` | — | `{ ok }` (offline cameras only) |

### Recording

| Method | Path | Body | Response |
|--------|------|------|----------|
| `POST` | `/record/:id/start` | — | `{ ok }` |
| `POST` | `/record/:id/stop` | — | `{ ok }` |
| `GET` | `/recordings` | — | `{ [camId]: [{ name, size, mtime, duration }] }` |
| `GET` | `/recordings/:camId/:file` | — | MP4 stream (supports `Range`) |
| `GET` | `/recordings/:camId/:file/download` | — | MP4 download |
| `DELETE` | `/recordings/:camId/:file` | — | `{ ok }` |

### Settings

| Method | Path | Body | Response |
|--------|------|------|----------|
| `GET` | `/settings` | — | Current settings object |
| `PUT` | `/settings` | Partial settings object | Updated settings object |

#### Settings object shape

```json
{
  "motionEnabled":    true,
  "noMotionSecs":     180,
  "recordingEnabled": true,
  "recordOnBell":     false,
  "maxStorageGB":     10,
  "manualRecordMins": 30,
  "timezone":         "Europe/Prague"
}
```

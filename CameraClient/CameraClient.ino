#include "esp_camera.h"
#include "esp_sleep.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <WiFiClient.h>
#include <lwip/sockets.h>
#include <netdb.h>

#include "firmware_version.h"

#define CAMERA_MODEL_XIAO_ESP32S3 // Has PSRAM

#include "camera_pins.h"

#define PRODUCTION_ENVIRONMENT 1
#define IGNORE_BATTERY_PERCENTAGE 1

#define BUTTON_PIN D3
#define BUZZER_PIN D2

#if PRODUCTION_ENVIRONMENT
  // ===========================
  // Production credentials
  // ===========================
  const char* ssid       = "Mavrik";
  const char* password   = "eKaeru44yNyk";
  const char* serverHost = "api.portal-view.panelo.duckdns.org";
  const char* otaHost    = "ota.portal-view.panelo.duckdns.org";
#else
  // ===========================
  // Testing / dev credentials
  // ===========================
  const char* ssid       = "Mavrik";
  const char* password   = "eKaeru44yNyk";
  const char* serverHost = "192.168.0.129";
  const char* otaHost    = "192.168.0.129"; // same machine in dev
#endif

const uint16_t serverPort = 9005;
const uint16_t udpPort    = 9006;

WiFiClient tcpClient;
int        udpSock6 = -1;           // raw AF_INET6 SOCK_DGRAM socket
struct sockaddr_in6 udpServerAddr;  // pre-resolved server address for UDP

const size_t   UDP_PAYLOAD_SZ = 1400; // max JPEG bytes per UDP packet

uint32_t       frameSeq   = 0;       // monotonic frame counter for UDP
uint32_t       camHash    = 0;       // djb2 hash of camera ID (set once in setup)

// ── Motion / standby state ────────────────────────────────────────────────────
// 0x01 from server = active mode  (send every frame)
// 0x00 from server = standby mode (send 1 frame per STANDBY_DELAY_MS)
constexpr unsigned long STANDBY_DELAY_MS = 1000;
bool standbyMode = true; // start in standby until server detects motion

// ── Battery reporting ─────────────────────────────────────────────────────────
constexpr unsigned long BATTERY_INTERVAL_MS   = 5UL * 60UL * 1000UL;
unsigned long lastBatteryMs = 0; // 0 forces a send on first loop iteration

constexpr unsigned long HEARTBEAT_INTERVAL_MS = 5000UL; // TCP keepalive to server
unsigned long lastHeartbeatMs = 0;

constexpr uint8_t  BATTERY_LOW_PCT   = IGNORE_BATTERY_PERCENTAGE ? 0 : 5;    // threshold (%)
bool               batteryLow        = false;

// Build a stable unique ID from the WiFi MAC address.
// Format: "CAM-AABBCCDDEEFF"
String getCameraId() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char buf[20];
  snprintf(buf, sizeof(buf), "CAM-%02X%02X%02X%02X%02X%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

// Send the firmware version string using sentinel 0xFD.
// Wire format: [top byte 0xFD | 3-byte length][UTF-8 version string]
// The backend compares this against the latest deployed version and
// will immediately send CMD_OTA (0x10) if this camera is out of date.
bool sendFirmwareVersion() {
  const char* ver = FIRMWARE_VERSION;
  uint32_t len = (uint32_t)strlen(ver);
  uint32_t hdr = 0xFD000000UL | (len & 0x00FFFFFFUL);
  uint8_t buf[4] = {
    (uint8_t)(hdr >> 24),
    (uint8_t)(hdr >> 16),
    (uint8_t)(hdr >>  8),
    (uint8_t)(hdr      )
  };
  Serial.printf("[FW] Reporting version: %s\n", ver);
  return tcpSendAll(buf, 4) && tcpSendAll((const uint8_t*)ver, len);
}

// Send the camera ID as a length-prefixed UTF-8 string.
// Wire format: [4-byte big-endian uint32 length][UTF-8 bytes]
bool sendCameraId() {
  String id = getCameraId();
  uint32_t len = id.length();
  uint8_t header[4] = {
    (uint8_t)(len >> 24),
    (uint8_t)(len >> 16),
    (uint8_t)(len >>  8),
    (uint8_t)(len      )
  };
  Serial.printf("Sending camera ID: %s\n", id.c_str());
  return tcpSendAll(header, 4) && tcpSendAll((const uint8_t*)id.c_str(), len);
}

// ── OTA update ───────────────────────────────────────────────────────────────
// Triggered by command byte 0x10 from the backend over TCP.
// Downloads firmware.bin from the Node.js OTA server and reboots.
void performOTA() {
  Serial.println("[OTA] Update requested by server");
  tcpClient.stop(); // release TCP before HTTP download

  // In production the OTA server is on its own subdomain on port 80.
  // In dev it shares the same IP as the backend but also uses port 80.
  String url = String("http://") + otaHost + "/firmware.bin";
  Serial.printf("[OTA] Downloading: %s\n", url.c_str());

  WiFiClient otaClient;
  httpUpdate.setLedPin(LED_BUILTIN, LOW);
  httpUpdate.rebootOnUpdate(true);

  t_httpUpdate_return ret = httpUpdate.update(otaClient, url);
  switch (ret) {
    case HTTP_UPDATE_FAILED:
      Serial.printf("[OTA] Failed (%d): %s\n",
                    httpUpdate.getLastError(),
                    httpUpdate.getLastErrorString().c_str());
      break;
    case HTTP_UPDATE_NO_UPDATES:
      Serial.println("[OTA] Server reports no update available");
      break;
    case HTTP_UPDATE_OK:
      // rebootOnUpdate(true) — never reaches here
      break;
  }
  // If we reach here OTA failed; reconnect and resume normal operation
  delay(3000);
}

// ── Deep sleep ────────────────────────────────────────────────────────────────
constexpr uint64_t DEEP_SLEEP_US = 1 * 60ULL * 1000000ULL; // wake every 1 minute

void enterDeepSleep() {
  Serial.println("[Sleep] Entering deep sleep for 1 minute...");
  Serial.flush();
  tcpClient.stop();
  WiFi.disconnect(true);
  delay(100);
  esp_sleep_enable_timer_wakeup(DEEP_SLEEP_US);
  esp_deep_sleep_start();
  // never returns
}

// Connect (or reconnect) to the stream server.
// Returns true if connected and ready to stream.
// Calls enterDeepSleep() (never returns) if the server commands sleep or battery is low.
bool connectToServer() {
  Serial.printf("Connecting to stream server %s:%u ...\n", serverHost, serverPort);
  if (tcpClient.connect(serverHost, serverPort)) {
    Serial.println("Connected.");
    if (!sendCameraId()) {
      Serial.println("Failed to send camera ID.");
      tcpClient.stop();
      return false;
    }

    // Send battery immediately so the server knows our charge level before any frames
    if (!sendBatteryPercent()) {
      Serial.println("Battery send after handshake failed.");
      tcpClient.stop();
      return false;
    }
    lastBatteryMs = millis(); // don't re-send immediately in loop()

    // Report firmware version so the backend can detect stale cameras
    if (!sendFirmwareVersion()) {
      Serial.println("Firmware version send failed.");
      tcpClient.stop();
      return false;
    }

    // If battery is critically low, go straight to deep sleep — no streaming
    if (batteryLow) {
      Serial.println("[Battery] Low on connect — entering deep sleep immediately.");
      enterDeepSleep(); // never returns
    }

    // Wait up to 500 ms for an immediate command from the server.
    // The server sends 0x02 right after the ID handshake if sleep is enabled.
    // It may also send 0x10 (OTA) immediately on reconnect.
    unsigned long t = millis();
    while (millis() - t < 500) {
      if (tcpClient.available() > 0) {
        uint8_t cmd = tcpClient.read();
        if (cmd == 0x02) {
          Serial.println("[Sleep] Server commanded sleep after handshake.");
          enterDeepSleep(); // never returns
        } else if (cmd == 0x10) {
          Serial.println("[OTA] Server commanded update after handshake.");
          performOTA(); // reboots on success, returns on failure
          return false; // force reconnect
        }
        // Any other command (active/standby/framesize) — loop() will handle it
        break;
      }
      delay(10);
    }
    return true;
  }
  Serial.println("Connection failed, will retry.");
  return false;
}

// Write exactly len bytes; returns false if the connection drops.
bool tcpSendAll(const uint8_t* buf, size_t len) {
  size_t sent = 0;
  while (sent < len) {
    int n = tcpClient.write(buf + sent, len - sent);
    if (n <= 0) return false;
    sent += n;
  }
  return true;
}

// ── UDP socket (IPv6) ────────────────────────────────────────────────────────
// WiFiUDP only creates AF_INET sockets internally and silently drops packets
// destined for IPv6 addresses. We use lwIP POSIX sockets directly instead.
bool setupUdp6Socket() {
  if (udpSock6 >= 0) {
    close(udpSock6);
    udpSock6 = -1;
  }

  // Resolve server hostname to an IPv6 address
  struct addrinfo hints = {};
  hints.ai_family   = AF_INET6;
  hints.ai_socktype = SOCK_DGRAM;
  hints.ai_flags    = AI_V4MAPPED | AI_ADDRCONFIG;

  char portStr[8];
  snprintf(portStr, sizeof(portStr), "%u", udpPort);

  struct addrinfo* res = nullptr;
  int rc = getaddrinfo(serverHost, portStr, &hints, &res);
  if (rc != 0 || !res) {
    Serial.printf("[UDP6] getaddrinfo failed: %d\n", rc);
    return false;
  }

  memcpy(&udpServerAddr, res->ai_addr, sizeof(udpServerAddr));
  freeaddrinfo(res);

  char addrStr[INET6_ADDRSTRLEN] = {};
  inet_ntop(AF_INET6, &udpServerAddr.sin6_addr, addrStr, sizeof(addrStr));
  Serial.printf("[UDP6] Resolved server: [%s]:%u\n", addrStr, udpPort);

  udpSock6 = socket(AF_INET6, SOCK_DGRAM, IPPROTO_UDP);
  if (udpSock6 < 0) {
    Serial.printf("[UDP6] socket() failed: errno=%d\n", errno);
    return false;
  }

  Serial.println("[UDP6] Socket ready (blocking)");
  return true;
}

// ── djb2 hash ────────────────────────────────────────────────────────────────
// djb2 hash — same algorithm used server-side to map packets to cameras.
uint32_t djb2Hash(const char* str) {
  uint32_t hash = 5381;
  while (*str) {
    hash = ((hash << 5) + hash) + (uint8_t)(*str++);
  }
  return hash;
}

uint32_t getCamHash() {
  String id = getCameraId();
  return djb2Hash(id.c_str());
}

// Send one JPEG frame via UDP, split into fragments of UDP_PAYLOAD_SZ bytes.
// Each packet header (16 bytes):
//   [4] cam_hash  [4] frame_seq  [2] frag_idx  [2] frag_total  [4] frame_size
void sendFrameViaUDP(camera_fb_t* fb) {
  uint32_t totalSize  = (uint32_t)fb->len;
  uint16_t fragTotal  = (uint16_t)((totalSize + UDP_PAYLOAD_SZ - 1) / UDP_PAYLOAD_SZ);
  uint32_t seq        = frameSeq++;

  // Log every 30th frame so we can confirm UDP is firing without flooding Serial
  bool verbose = (seq % 30 == 0);
  if (verbose) {
    char addrStr[INET6_ADDRSTRLEN] = {};
    inet_ntop(AF_INET6, &udpServerAddr.sin6_addr, addrStr, sizeof(addrStr));
    Serial.printf("[UDP6] frame seq=%u  size=%u B  frags=%u  hash=0x%08X  dst=[%s]:%u\n",
                  seq, totalSize, fragTotal, camHash, addrStr, udpPort);
  }

  for (uint16_t i = 0; i < fragTotal; i++) {
    // Yield to the WiFi radio task every 16 fragments so it can drain the TX queue
    // before we add more. Without this the pbuf pool exhausts and sendto returns ENOMEM.
    if ((i & 0x0F) == 0 && i > 0) {
      vTaskDelay(1); // 1 tick ≈ 1 ms — enough for the WiFi task to flush buffered packets
    }

    // Keep the TCP connection alive during long frame sends
    unsigned long nowMs = millis();
    if (nowMs - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
      uint8_t hb[4] = {0xFE, 0x00, 0x00, 0x00};
      tcpSendAll(hb, 4);
      lastHeartbeatMs = nowMs;
    }

    size_t offset  = (size_t)i * UDP_PAYLOAD_SZ;
    size_t fragLen = min((size_t)UDP_PAYLOAD_SZ, (size_t)(totalSize - offset));

    uint8_t hdr[16];
    hdr[0]  = (uint8_t)(camHash   >> 24);
    hdr[1]  = (uint8_t)(camHash   >> 16);
    hdr[2]  = (uint8_t)(camHash   >>  8);
    hdr[3]  = (uint8_t)(camHash        );
    hdr[4]  = (uint8_t)(seq       >> 24);
    hdr[5]  = (uint8_t)(seq       >> 16);
    hdr[6]  = (uint8_t)(seq       >>  8);
    hdr[7]  = (uint8_t)(seq            );
    hdr[8]  = (uint8_t)(i         >>  8);
    hdr[9]  = (uint8_t)(i              );
    hdr[10] = (uint8_t)(fragTotal  >>  8);
    hdr[11] = (uint8_t)(fragTotal       );
    hdr[12] = (uint8_t)(totalSize  >> 24);
    hdr[13] = (uint8_t)(totalSize  >> 16);
    hdr[14] = (uint8_t)(totalSize  >>  8);
    hdr[15] = (uint8_t)(totalSize       );

    // Assemble header + payload into a single datagram
    uint8_t pkt[16 + UDP_PAYLOAD_SZ];
    memcpy(pkt, hdr, 16);
    memcpy(pkt + 16, fb->buf + offset, fragLen);

    // Retry on ENOMEM: lwIP pbuf pool temporarily exhausted — wait for WiFi task to free buffers
    ssize_t sent;
    for (int retry = 0; retry < 8; retry++) {
      sent = sendto(udpSock6, pkt, 16 + fragLen, 0,
                    (struct sockaddr*)&udpServerAddr, sizeof(udpServerAddr));
      if (sent >= 0) break;
      if (errno == ENOMEM) {
        vTaskDelay(2); // wait 2 ms for WiFi task to drain
      } else {
        Serial.printf("[UDP6] sendto error frag %u/%u (seq=%u): errno=%d\n", i, fragTotal, seq, errno);
        return;
      }
    }
    if (sent < 0) {
      // Still failing after retries — skip this frame rather than spam the log
      return;
    }
  }

  if (verbose) {
    Serial.printf("[UDP] frame seq=%u sent OK (%u frags)\n", seq, fragTotal);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(A0, INPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  Serial.setDebugOutput(true);
  Serial.println();

  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0       = Y2_GPIO_NUM;
  config.pin_d1       = Y3_GPIO_NUM;
  config.pin_d2       = Y4_GPIO_NUM;
  config.pin_d3       = Y5_GPIO_NUM;
  config.pin_d4       = Y6_GPIO_NUM;
  config.pin_d5       = Y7_GPIO_NUM;
  config.pin_d6       = Y8_GPIO_NUM;
  config.pin_d7       = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.frame_size   = FRAMESIZE_QXGA;
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode    = CAMERA_GRAB_LATEST;
  config.fb_location  = CAMERA_FB_IN_PSRAM;
  config.jpeg_quality = 10;
  config.fb_count     = 2;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x\n", err);
    return;
  }

  sensor_t* s = esp_camera_sensor_get();
  if (s->id.PID == OV3660_PID) {
    s->set_vflip(s, 1);
    s->set_brightness(s, 1);
    s->set_saturation(s, -1);
  }
  //s->set_framesize(s, FRAMESIZE_QXGA);

  WiFi.enableIPv6();
  WiFi.begin(ssid, password);
  WiFi.setSleep(false);

  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  setupUdp6Socket();
  connectToServer();
  camHash = getCamHash(); // compute once — used in every UDP frame header
  Serial.printf("[UDP6] camHash=0x%08X\n", camHash);
  Serial.printf("[WiFi] Local IP: %s  RSSI: %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
}

float readBatteryVoltage() {
  long sum = 0;
  for (int i = 0; i < 16; i++) {
    sum += analogReadMilliVolts(A0);
  }
  float mv = sum / 16.0;      // already millivolts
  return (mv / 1000.0) * 2.0; // volts + undo 10k/10k divider
}

// Convert voltage to percentage (LiPo: 3.0 V = 0 %, 4.2 V = 100 %)
uint8_t batteryPercent() {
  if (IGNORE_BATTERY_PERCENTAGE) {
    return 100;
  }

  float v = readBatteryVoltage();
  float pct = (v - 3.0f) / (4.2f - 3.0f) * 100.0f;
  if (pct < 0.0f)   pct = 0.0f;
  if (pct > 100.0f) pct = 100.0f;
  return (uint8_t)pct;
}

// Send battery percentage as a sentinel 4-byte message.
// Wire format: top byte = 0xFF (sentinel), low byte = percentage 0-100.
bool sendBatteryPercent() {
  uint8_t pct = batteryPercent();

  // Update low-battery flag and log transitions
  if (pct < BATTERY_LOW_PCT && !batteryLow) {
    batteryLow = true;
    Serial.printf("[Battery] LOW — %u%% (< %u%%) — stopping camera capture\n", pct, BATTERY_LOW_PCT);
  } else if (pct >= BATTERY_LOW_PCT && batteryLow) {
    batteryLow = false;
    Serial.printf("[Battery] Recovered — %u%% — resuming camera capture\n", pct);
  } else {
    Serial.printf("[Battery] %u%%%s\n", pct, batteryLow ? " (LOW)" : "");
  }

  uint32_t msg = 0xFF000000UL | pct;
  uint8_t buf[4] = {
    (uint8_t)(msg >> 24),
    (uint8_t)(msg >> 16),
    (uint8_t)(msg >>  8),
    (uint8_t)(msg      )
  };
  return tcpSendAll(buf, 4);
}

// ── Button / buzzer ─────────────────────────────────────────────────────────
static bool lastButtonState = HIGH;
static unsigned long lastDebounceMs = 0;
constexpr unsigned long DEBOUNCE_MS = 50;

void loop() {
  // ── Button press → buzz ───────────────────────────────────────────────────
  bool reading = digitalRead(BUTTON_PIN);
  if (reading != lastButtonState) {
    lastDebounceMs = millis();
  }
  if ((millis() - lastDebounceMs) >= DEBOUNCE_MS) {
    if (reading == LOW) {          // button pressed (pulled to GND)
      Serial.println("[Button] Pressed");
      tone(BUZZER_PIN, 1000, 200); // 1 kHz for 200 ms
      // Notify backend — sentinel 0xFC, no payload
      if (tcpClient.connected()) {
        uint8_t msg[4] = {0xFC, 0x00, 0x00, 0x00};
        tcpSendAll(msg, 4);
      }
    }
  }
  lastButtonState = reading;

  // Reconnect if the TCP connection dropped
  if (!tcpClient.connected()) {
    delay(2000);
    connectToServer();
    return;
  }

  unsigned long now = millis();

  // ── TCP heartbeat — keeps the server-side idle timer from firing ───────────
  if (now - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
    uint8_t hb[4] = {0xFE, 0x00, 0x00, 0x00};
    if (!tcpSendAll(hb, 4)) {
      Serial.println("Heartbeat send failed, closing connection.");
      tcpClient.stop();
      return;
    }
    lastHeartbeatMs = now;
  }

  // Send battery percentage every BATTERY_INTERVAL_MS
  if (now - lastBatteryMs >= BATTERY_INTERVAL_MS) {
    if (!sendBatteryPercent()) {
      Serial.println("Battery send failed, closing connection.");
      tcpClient.stop();
      return;
    }
    lastBatteryMs = now;
  }

  // ── Battery low: pause streaming ──────────────────────────────────────────
  if (batteryLow) {
    delay(5000);
    return;
  }

  // ── Normal operation: capture and send camera frame via UDP ───────────────
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Frame capture failed");
    delay(100);
    return;
  }

  sendFrameViaUDP(fb);
  esp_camera_fb_return(fb);

  // Read any mode commands sent back by the server over TCP
  while (tcpClient.available() > 0) {
    uint8_t cmd = (uint8_t)tcpClient.read();
    if (cmd == 0x01 && standbyMode) {
      standbyMode = false;
      Serial.println("[Mode] Active");
    } else if (cmd == 0x00 && !standbyMode) {
      standbyMode = true;
      Serial.println("[Mode] Standby");
    } else if (cmd == 0x02) {
      Serial.println("[Sleep] Server commanded sleep while streaming.");
      enterDeepSleep(); // never returns
    } else if (cmd == 0x10) {
      Serial.println("[OTA] Server commanded firmware update.");
      performOTA(); // reboots on success, returns on failure
      return;       // force reconnect on failure
    } else if (cmd >= 0x03 && cmd <= 0x06) {
      const framesize_t sizes[] = {
        FRAMESIZE_SXGA,
        FRAMESIZE_UXGA,
        FRAMESIZE_FHD,
        FRAMESIZE_QXGA,
      };
      const char* names[] = { "SXGA 1280x1024", "UXGA 1600x1200", "FHD 1920x1080", "QXGA 2048x1536" };
      int idx = cmd - 0x03;
      sensor_t* s = esp_camera_sensor_get();
      if (s) {
        s->set_framesize(s, sizes[idx]);
        Serial.printf("[FrameSize] Changed to %s\n", names[idx]);
      }
    }
  }

  if (standbyMode) {
    delay(STANDBY_DELAY_MS);
  }
  
}

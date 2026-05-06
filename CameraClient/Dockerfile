# ─── Stage 1: toolchain & compile ────────────────────────────────────────────
FROM debian:bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        python3 \
        python3-pip \
    && pip3 install --break-system-packages pyserial \
    && rm -rf /var/lib/apt/lists/*

# Install arduino-cli
RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
    | BINDIR=/usr/local/bin sh

# Store the board index URL in an env var so shell line-continuation can't split it
ENV ESP32_INDEX_URL="https://espressif.github.io/arduino-esp32/package_esp32_index.json"

# Add Espressif board index and install the ESP32 core.
# Pinned to 2.0.17 (last stable 2.x): WiFiUDP.h was removed in 3.x but is
# required by this sketch. XIAO_ESP32S3 and the camera driver ship since 2.0.5.
RUN arduino-cli config init \
    && arduino-cli core update-index --additional-urls "$ESP32_INDEX_URL" \
    && arduino-cli core install esp32:esp32@2.0.17 --additional-urls "$ESP32_INDEX_URL" \
    && arduino-cli core list

WORKDIR /sketch/CameraClient

COPY . .

# Inject the firmware version (git SHA passed from CI as a build arg).
# This overrides the "dev" fallback in firmware_version.h.
ARG FIRMWARE_VERSION=dev
RUN printf '#define FIRMWARE_VERSION "%s"\n' "${FIRMWARE_VERSION}" > firmware_version.h

# FQBN for Seeed XIAO ESP32S3:
#   PSRAM=opi           – OPI PSRAM (8 MB on the Sense variant)
#   USBMode=default     – built-in USB-CDC
#   FlashMode=qio       – QIO flash (default for S3)
# PartitionScheme=custom is not a valid FQBN option for this board; instead we
# override the partition properties directly so arduino-cli picks up the
# partitions.csv that lives in the sketch directory.
RUN arduino-cli compile \
        --fqbn "esp32:esp32:XIAO_ESP32S3:PSRAM=opi,USBMode=default,FlashMode=qio" \
        --additional-urls "$ESP32_INDEX_URL" \
        --build-property "build.partitions=partitions" \
        --build-property "upload.maximum_size=3932160" \
        --export-binaries \
        .

# Isolate the application binary that HTTPUpdate needs (not bootloader/partition bins)
RUN mkdir -p /output \
    && find build -name "CameraClient.ino.bin" | head -1 | xargs -I{} cp {} /output/firmware.bin \
    && echo "${FIRMWARE_VERSION}" > /output/version.txt

# ─── Stage 2: OTA firmware server ────────────────────────────────────────────
FROM node:20-slim AS ota-server

WORKDIR /app

# Install production dependencies only
COPY package.json .
RUN npm install --omit=dev

COPY ota-server.js .

# Copy the compiled application binary into the expected location
RUN mkdir -p firmware
COPY --from=builder /output/firmware.bin firmware/firmware.bin
COPY --from=builder /output/version.txt  firmware/version.txt

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
    CMD node -e "fetch('http://localhost/healthz').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "ota-server.js"]

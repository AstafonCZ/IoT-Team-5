FROM node:22-slim

# ffmpeg is required for video recording
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg imagemagick \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install

COPY . .

EXPOSE ${HTTP_PORT}
EXPOSE ${TCP_PORT}
EXPOSE ${UDP_PORT}

RUN apt-get update && apt-get install -y wget && rm -rf /var/lib/apt/lists/*

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:${HTTP_PORT:-3001}/healthz || exit 1

CMD ["npm", "run", "dev"]

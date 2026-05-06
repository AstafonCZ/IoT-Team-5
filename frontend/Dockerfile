FROM node:22-slim

WORKDIR /app

COPY package.json .
RUN npm install

COPY . .

EXPOSE 80

RUN apt-get update && apt-get install -y wget && rm -rf /var/lib/apt/lists/*

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:80/ || exit 1

CMD ["npm", "run", "dev"]

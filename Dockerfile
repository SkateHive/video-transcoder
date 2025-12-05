# Simple ffmpeg + Node worker
FROM node:20-bullseye-slim

# Install ffmpeg and curl for health checks
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]

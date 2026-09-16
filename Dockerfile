# ==== Stage 1: Build TypeScript ====
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ==== Stage 2: Production runtime ====
FROM node:20-alpine AS runtime

# Cài đặt ffmpeg (bao gồm ffprobe) - bắt buộc cho Level 3 analysis
RUN apk add --no-cache ffmpeg wget

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY config.json ./config.json

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]

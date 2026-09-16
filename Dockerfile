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
# config.json thật KHÔNG có trong repo (gitignore vì chứa URL luồng nội bộ) nên không thể COPY ở build-time.
# Đóng gói config.example.json làm cấu hình mặc định (placeholder) để image tự chạy được ngay khi start;
# ở production PHẢI mount config.json thật đè lên qua Volume/File mount của Coolify (xem README mục 4.1.4).
COPY config.example.json ./config.json

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]

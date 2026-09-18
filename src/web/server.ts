import path from "path";
import crypto from "crypto";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { HealthStatus, StreamPhase } from "../types";
import { getAllStates, getAllLastResults } from "../monitor/stateStore";
import { getStreams } from "../monitor/streamRegistry";
import { getEventLoopLagMs, getMemoryPressure } from "../monitor/eventLoopMonitor";
import { getFfprobeQueueStats } from "../ffmpeg/ffprobe";
import { createChildLogger } from "../logger/logger";

const log = createChildLogger("web-server");

/** Trạng thái đơn giản hóa cho dashboard: 3 màu thay vì OK/DEGRADED/DOWN + STABLE/SUSPECT nội bộ. */
export type DashboardStatus = "HEALTHY" | "SUSPECT" | "DEGRADED";

function toDashboardStatus(lastStatus: HealthStatus, phase: StreamPhase): DashboardStatus {
  if (phase === "SUSPECT") return "SUSPECT";
  return lastStatus === "OK" ? "HEALTHY" : "DEGRADED";
}

export interface DashboardStream {
  id: string;
  name: string;
  partner: string;
  url: string;
  type: "tv" | "radio";
  status: DashboardStatus;
  rawStatus: HealthStatus;
  lastError: string | null;
  videoBitrateKbps: number | null;
  audioBitrateKbps: number | null;
  checkedAt: string | null;
}

export interface DashboardPayload {
  generatedAt: string;
  resources: {
    eventLoopLagMs: number;
    heapUsedRatio: number;
    rssMb: number;
    ffprobeQueue: { size: number; pending: number };
  };
  streams: DashboardStream[];
}

/** Gộp state (stateStore) + kết quả check gần nhất + metadata config (url/type) thành 1 payload cho dashboard/API. */
export function buildStatusPayload(): DashboardPayload {
  const states = getAllStates();
  const lastResults = new Map(getAllLastResults().map((r) => [r.id, r]));

  const streams: DashboardStream[] = getStreams().map((streamConfig) => {
    const state = states.get(streamConfig.id);
    const result = lastResults.get(streamConfig.id);

    return {
      id: streamConfig.id,
      name: streamConfig.name,
      partner: streamConfig.partner,
      url: streamConfig.url,
      type: streamConfig.type,
      status: state ? toDashboardStatus(state.lastStatus, state.phase) : "SUSPECT",
      rawStatus: state?.lastStatus ?? "OK",
      lastError: result?.issues[0] ?? null,
      videoBitrateKbps: result?.av?.videoBitrateKbps ?? null,
      audioBitrateKbps: result?.av?.audioBitrateKbps ?? null,
      checkedAt: state?.lastCheckedAt ? state.lastCheckedAt.toISOString() : null,
    };
  });

  const mem = getMemoryPressure();

  return {
    generatedAt: new Date().toISOString(),
    resources: {
      eventLoopLagMs: getEventLoopLagMs(),
      heapUsedRatio: Number(mem.heapUsedRatio.toFixed(3)),
      rssMb: Math.round(mem.rssMb),
      ffprobeQueue: getFfprobeQueueStats(),
    },
    streams,
  };
}

const SSE_PUSH_INTERVAL_MS = 3000;

/** So sánh chuỗi thời gian không đổi (chống timing attack), yêu cầu 2 buffer bằng độ dài. */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Basic Auth cho Dashboard/API - CHỈ bật khi cả DASHBOARD_USER và DASHBOARD_PASSWORD được khai báo
 * trong biến môi trường. Nếu thiếu 1 trong 2 (hoặc cả 2), bỏ qua hoàn toàn để dễ chạy/test local -
 * đúng yêu cầu: mặc định không auth trừ khi chủ động khai báo.
 */
function basicAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASSWORD;

  if (!user || !pass) {
    next();
    return;
  }

  const header = req.headers.authorization;
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
    const sepIndex = decoded.indexOf(":");
    const reqUser = sepIndex >= 0 ? decoded.slice(0, sepIndex) : decoded;
    const reqPass = sepIndex >= 0 ? decoded.slice(sepIndex + 1) : "";

    if (safeCompare(reqUser, user) && safeCompare(reqPass, pass)) {
      next();
      return;
    }
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="FalconHLS Monitor Dashboard"');
  res.status(401).send("Yêu cầu xác thực để truy cập Dashboard.");
}

function createApp(): Express {
  const app = express();
  const publicDir = path.join(__dirname, "..", "..", "public");

  // /health đăng ký TRƯỚC middleware auth - Docker HEALTHCHECK (wget nội bộ trong container,
  // không có credential) phải luôn truy cập được bất kể DASHBOARD_USER/PASSWORD có cấu hình hay không.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", ...buildStatusPayload() });
  });

  app.use(basicAuthMiddleware);
  app.use(express.static(publicDir));

  app.get("/api/status", (_req: Request, res: Response) => {
    res.json(buildStatusPayload());
  });

  app.get("/api/events", (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const push = () => {
      res.write(`data: ${JSON.stringify(buildStatusPayload())}\n\n`);
    };

    push();
    const interval = setInterval(push, SSE_PUSH_INTERVAL_MS);

    req.on("close", () => {
      clearInterval(interval);
    });
  });

  return app;
}

export function startWebServer(port: number) {
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASSWORD;

  if (user && pass) {
    log.info("Basic Auth cho Dashboard/API đang BẬT (DASHBOARD_USER/DASHBOARD_PASSWORD đã khai báo)");
  } else if (user || pass) {
    log.warn(
      "Chỉ khai báo 1 trong 2 biến DASHBOARD_USER/DASHBOARD_PASSWORD - Basic Auth sẽ KHÔNG được bật. Cần khai báo đủ cả 2 để bật auth."
    );
  } else {
    log.warn("Dashboard/API đang chạy KHÔNG có Basic Auth (không khai báo DASHBOARD_USER/DASHBOARD_PASSWORD)");
  }

  const app = createApp();
  const server = app.listen(port, () => {
    log.info(`Web Dashboard + API đang chạy tại cổng ${port}`);
  });
  return server;
}

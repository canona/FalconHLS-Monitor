import http from "http";
import { getAllLastResults, getAllStates } from "./stateStore";
import { getFfprobeQueueStats } from "../ffmpeg/ffprobe";
import { getEventLoopLagMs, getMemoryPressure } from "./eventLoopMonitor";
import { createChildLogger } from "../logger/logger";

const log = createChildLogger("health-server");

/**
 * HTTP endpoint đơn giản phục vụ health check của Coolify/Docker, đồng thời hữu ích để xem
 * nhanh trạng thái tất cả các luồng ĐANG giám sát (bao gồm cả những luồng đang trong chu trình
 * xác minh SUSPECT) và tình trạng tài nguyên hệ thống (event-loop lag, bộ nhớ, queue ffprobe).
 */
export function startHealthServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      const states = getAllStates();
      const lastResults = new Map(getAllLastResults().map((r) => [r.streamName, r]));

      const streams = Array.from(states.entries()).map(([name, state]) => {
        const result = lastResults.get(name);
        return {
          name,
          confirmedStatus: state.lastStatus,
          phase: state.phase,
          suspectAttempt: state.suspectAttempt,
          lastRawStatus: result?.status ?? null,
          issues: result?.issues ?? [],
          checkedAt: state.lastCheckedAt,
        };
      });

      const mem = getMemoryPressure();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          {
            status: "ok",
            resources: {
              eventLoopLagMs: getEventLoopLagMs(),
              heapUsedMb: Math.round(mem.heapUsedMb),
              heapUsedRatio: Number(mem.heapUsedRatio.toFixed(3)),
              rssMb: Math.round(mem.rssMb),
              ffprobeQueue: getFfprobeQueueStats(),
            },
            streams,
          },
          null,
          2
        )
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(port, () => {
    log.info(`Health-check server đang chạy tại cổng ${port}`);
  });

  return server;
}

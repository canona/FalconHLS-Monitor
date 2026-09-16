import http from "http";
import { getAllLastResults } from "./stateStore";
import { createChildLogger } from "../logger/logger";

const log = createChildLogger("health-server");

/**
 * HTTP endpoint đơn giản phục vụ health check của Coolify/Docker,
 * đồng thời hữu ích để xem nhanh trạng thái tất cả các luồng đang giám sát.
 */
export function startHealthServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      const results = getAllLastResults().map((r) => ({
        name: r.streamName,
        status: r.status,
        issues: r.issues,
        checkedAt: r.checkedAt,
      }));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", streams: results }, null, 2));
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

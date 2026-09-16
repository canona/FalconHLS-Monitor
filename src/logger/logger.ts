import winston from "winston";
import { formatVnTime } from "../utils/time";

const { combine, printf, colorize, errors, json } = winston.format;

/** Gắn timestamp theo giờ Việt Nam (GMT+7) cố định, không phụ thuộc timezone hệ thống. */
const vnTimestamp = winston.format((info) => {
  info.timestamp = formatVnTime(new Date());
  return info;
})();

const consoleFormat = combine(
  colorize(),
  vnTimestamp,
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return `[${ts}] ${level}: ${stack || message}${metaStr}`;
  })
);

const isProduction = process.env.NODE_ENV === "production";

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: isProduction ? combine(vnTimestamp, errors({ stack: true }), json()) : consoleFormat,
  transports: [new winston.transports.Console()],
  exitOnError: false,
});

export function createChildLogger(scope: string) {
  return logger.child({ scope });
}

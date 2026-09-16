import v8 from "v8";

const SAMPLE_INTERVAL_MS = 200;

let currentLagMs = 0;
let lastSampleAt = Date.now();
let started = false;

/**
 * Đo độ trễ Event Loop bằng kỹ thuật "drift sampling": đặt lịch chạy lại sau
 * đúng SAMPLE_INTERVAL_MS, phần chênh lệch thực tế chạy trễ hơn dự kiến chính
 * là thời gian Event Loop bị bận xử lý việc khác (GC, CPU-bound work...).
 * Không dùng để đo lỗi bộ nhớ - xem `getMemoryPressure()` cho việc đó.
 */
export function startEventLoopMonitor(): void {
  if (started) return;
  started = true;
  lastSampleAt = Date.now();

  const timer = setInterval(() => {
    const now = Date.now();
    const drift = now - lastSampleAt - SAMPLE_INTERVAL_MS;
    currentLagMs = Math.max(0, drift);
    lastSampleAt = now;
  }, SAMPLE_INTERVAL_MS);
  timer.unref();
}

export function getEventLoopLagMs(): number {
  return currentLagMs;
}

export interface MemoryPressure {
  heapUsedMb: number;
  heapTotalMb: number;
  rssMb: number;
  /** used_heap_size / heap_size_limit (giới hạn heap THẬT của V8) - KHÔNG dùng heapUsed/heapTotal. */
  heapUsedRatio: number;
}

/**
 * heapUsed/heapTotal (từ process.memoryUsage()) là chỉ số NHIỄU cho mục đích phát hiện quá tải:
 * V8 cố tình giữ heapTotal sát heapUsed và chỉ mở rộng khi cần, nên tỉ lệ này thường xuyên ở
 * mức 0.85-0.95 ngay cả khi hoàn toàn bình thường (đã kiểm chứng thực tế - gây false positive
 * SYSTEM_OVERLOAD liên tục). Dùng heap_size_limit (giới hạn heap THẬT mà V8 sẽ OOM nếu chạm tới,
 * từ `v8.getHeapStatistics()`) làm mẫu số mới phản ánh đúng "còn bao xa tới OOM".
 */
export function getMemoryPressure(): MemoryPressure {
  const mem = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();

  return {
    heapUsedMb: mem.heapUsed / 1024 / 1024,
    heapTotalMb: mem.heapTotal / 1024 / 1024,
    rssMb: mem.rss / 1024 / 1024,
    heapUsedRatio: heapStats.heap_size_limit > 0 ? heapStats.used_heap_size / heapStats.heap_size_limit : 0,
  };
}

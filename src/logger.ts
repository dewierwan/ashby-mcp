const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.LOG_LEVEL ?? "info").toLowerCase() as Level] ?? LEVELS.info;

function log(level: Level, msg: string, data?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }) + "\n");
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log("error", msg, data),
};

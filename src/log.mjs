const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const TAGS = { error: "ERR", warn: "WRN", info: "INF", debug: "DBG" };

let threshold = LEVELS.info;

export function setLevel(name) {
  if (name && name in LEVELS) threshold = LEVELS[name];
}

export function levelNames() {
  return Object.keys(LEVELS);
}

function fields(obj) {
  const parts = [];
  for (const [key, value] of Object.entries(obj ?? {})) {
    if (value === undefined || value === null) continue;
    const text = String(value);
    parts.push(/[\s"=]/.test(text) ? `${key}="${text.replace(/"/g, '\\"')}"` : `${key}=${text}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function emit(level, message, extra) {
  if (LEVELS[level] > threshold) return;
  const line = `${new Date().toISOString()} [${TAGS[level]}] ${message}${fields(extra)}\n`;
  if (level === "error" || level === "warn") process.stderr.write(line);
  else process.stdout.write(line);
}

export const log = {
  error: (message, extra) => emit("error", message, extra),
  warn: (message, extra) => emit("warn", message, extra),
  info: (message, extra) => emit("info", message, extra),
  debug: (message, extra) => emit("debug", message, extra),
  /** A child logger that stamps every line with the same fields. */
  child(bound) {
    return {
      error: (m, e) => emit("error", m, { ...bound, ...e }),
      warn: (m, e) => emit("warn", m, { ...bound, ...e }),
      info: (m, e) => emit("info", m, { ...bound, ...e }),
      debug: (m, e) => emit("debug", m, { ...bound, ...e }),
      child(more) {
        return log.child({ ...bound, ...more });
      },
    };
  },
};

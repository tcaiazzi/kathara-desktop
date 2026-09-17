/**
 * Appends to a single log file that "Help → Show backend log" opens. The backend's own
 * stdout/stderr is piped in verbatim, because when startup fails its traceback is the only
 * thing that explains why.
 */
import fs from "node:fs";
import path from "node:path";
import { logFile } from "./paths";

let stream: fs.WriteStream | null = null;

/** Above this size, the log is truncated down to its last half on the next process start
 * (see `rotateIfOversized`) — otherwise it grows forever across restarts, and every "Show
 * backend log"/crash-screen read of it (`tailLog` below) gets slower as it does. */
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const TRUNCATION_MARKER = "[... earlier log truncated ...]\n";

/** Keeps only the newest half of `file` once it exceeds `MAX_LOG_BYTES`. Best-effort: any
 * failure just leaves the file as-is rather than blocking startup on a log-hygiene concern. */
function rotateIfOversized(file: string): void {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // no file yet
  }
  if (size <= MAX_LOG_BYTES) {
    return;
  }
  try {
    const keep = Math.floor(MAX_LOG_BYTES / 2);
    const buf = Buffer.alloc(keep);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, keep, size - keep);
    } finally {
      fs.closeSync(fd);
    }
    fs.writeFileSync(file, TRUNCATION_MARKER + buf.toString("utf8"));
  } catch {
    // Leave the oversized file alone rather than risk losing it entirely.
  }
}

function out(): fs.WriteStream {
  if (!stream) {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    rotateIfOversized(logFile());
    stream = fs.createWriteStream(logFile(), { flags: "a" });
  }
  return stream;
}

/** A shell-level line, marked so it is distinguishable from backend output. */
export function log(message: string): void {
  const line = `[${new Date().toISOString()}] [shell] ${message}`;
  console.log(line);
  out().write(`${line}\n`);
}

/** Matches a pairing-token query param (`?token=...` / `&token=...`) so it can be redacted out of
 * the backend's own stdout/stderr before it reaches a file the app invites the user to open and
 * share (Help menu, the setup/error page's log tail). The token travels this way on the TTY
 * WebSocket and stats EventSource URLs (services/frontend/src/services/api.ts), which can't set
 * an Authorization header — defence-in-depth alongside backend.ts's `--no-access-log`, which stops
 * the routine access-log line at the source; this covers any other way a raw URL might end up in
 * the backend's own output (a traceback, a future caller logging a request).
 *
 * Not airtight on its own: a `data` event's chunk boundary is a pipe-buffer artifact, not a line
 * boundary, so a token could in principle land split across two chunks and dodge this regex. That
 * residual risk is why `--no-access-log` is the primary fix and this is deliberately the backstop,
 * not the other way around. */
const TOKEN_QUERY_PARAM_RE = /([?&]token=)[^\s&"'<>]+/gi;

/** Backend output, redacting a pairing token out of any URL it contains. */
export function logRaw(chunk: string): void {
  const redacted = chunk.replace(TOKEN_QUERY_PARAM_RE, "$1***");
  process.stdout.write(redacted);
  out().write(redacted);
}

/** How much of the file's tail `tailLog` reads before splitting into lines — bounded so a
 * multi-hundred-KB log doesn't mean reading the whole thing synchronously on the main thread
 * just to keep its last `limit` lines. */
const TAIL_READ_BYTES = 64 * 1024;

/** The last `limit` lines, for the error screen — a traceback is useless if it isn't shown. */
export function tailLog(limit = 60): string {
  try {
    const file = logFile();
    const { size } = fs.statSync(file);
    const readSize = Math.min(size, TAIL_READ_BYTES);
    const buf = Buffer.alloc(readSize);
    if (readSize > 0) {
      const fd = fs.openSync(file, "r");
      try {
        fs.readSync(fd, buf, 0, readSize, size - readSize);
      } finally {
        fs.closeSync(fd);
      }
    }
    const lines = buf.toString("utf8").split("\n");
    // A partial read starts mid-line: drop that leading fragment unless it's the whole file.
    const usable = readSize < size ? lines.slice(1) : lines;
    return usable.slice(-limit).join("\n");
  } catch {
    return "";
  }
}

/**
 * Appends to a single log file that "Help → Show backend log" opens. The backend's own
 * stdout/stderr is piped in verbatim, because when startup fails its traceback is the only
 * thing that explains why.
 */
import fs from "node:fs";
import path from "node:path";
import { logFile } from "./paths";

let stream: fs.WriteStream | null = null;

function out(): fs.WriteStream {
  if (!stream) {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
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

/** The last `limit` lines, for the error screen — a traceback is useless if it isn't shown. */
export function tailLog(limit = 60): string {
  try {
    const lines = fs.readFileSync(logFile(), "utf8").split("\n");
    return lines.slice(-limit).join("\n");
  } catch {
    return "";
  }
}

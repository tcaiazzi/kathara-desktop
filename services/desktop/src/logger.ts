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

/** Backend output, written through unchanged. */
export function logRaw(chunk: string): void {
  process.stdout.write(chunk);
  out().write(chunk);
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

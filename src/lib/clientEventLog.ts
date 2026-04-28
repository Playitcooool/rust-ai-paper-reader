import type { AppendClientEventLogInput, ClientLogEvent } from "./contracts";

type AppendFn = (input: AppendClientEventLogInput) => Promise<void>;

type ClientEventLogOptions = {
  appendFn: AppendFn;
  sessionId: string;
  flushIntervalMs?: number;
};

type ClientEventLogState = {
  appendFn: AppendFn;
  sessionId: string;
  flushIntervalMs: number;
  timer: number | null;
  queue: ClientLogEvent[];
  flushing: boolean;
  disposed: boolean;
};

let state: ClientEventLogState | null = null;

export function normalizeTextSnippet(value: string, maxLen = 120): string {
  // Collapse whitespace to keep logs compact and safe to view in terminals.
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  // Avoid leaving a trailing space when truncating.
  return normalized.slice(0, maxLen).trimEnd();
}

export function textForLog(value: string | null | undefined): { text_len: number; text_snippet: string } | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return {
    text_len: trimmed.length,
    text_snippet: normalizeTextSnippet(trimmed, 120),
  };
}

async function flushQueue(reason: string) {
  const current = state;
  if (!current) return;
  if (current.disposed) return;
  if (current.flushing) return;
  if (current.queue.length === 0) return;

  current.flushing = true;
  const batch = current.queue;
  current.queue = [];
  try {
    await current.appendFn({
      session_id: current.sessionId,
      events: [
        { ts_ms: Date.now(), kind: "log_flush", data: { reason, count: batch.length } },
        ...batch,
      ],
    });
  } catch {
    // Best-effort: if append fails, keep moving. (We intentionally drop the batch to avoid infinite retry loops.)
  } finally {
    current.flushing = false;
  }
}

export function startClientEventLog(options: ClientEventLogOptions) {
  const flushIntervalMs = options.flushIntervalMs ?? 2000;
  state?.timer && window.clearInterval(state.timer);

  state = {
    appendFn: options.appendFn,
    sessionId: options.sessionId,
    flushIntervalMs,
    timer: window.setInterval(() => void flushQueue("interval"), flushIntervalMs),
    queue: [],
    flushing: false,
    disposed: false,
  };

  const onVisibility = () => {
    if (document.visibilityState === "hidden") void flushQueue("visibility_hidden");
  };
  document.addEventListener("visibilitychange", onVisibility);

  // "pagehide" fires more reliably than "beforeunload" for modern browsers.
  const onPageHide = () => void flushQueue("pagehide");
  window.addEventListener("pagehide", onPageHide);

  return () => {
    const current = state;
    if (!current) return;
    current.disposed = true;
    if (current.timer) window.clearInterval(current.timer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    void flushQueue("stop");
    state = null;
  };
}

export function logEvent(kind: string, data?: Record<string, unknown>) {
  const current = state;
  if (!current) return;
  if (current.disposed) return;
  current.queue.push({
    ts_ms: Date.now(),
    kind,
    data: data ?? {},
  });
  if (current.queue.length >= 100) void flushQueue("queue_full");
}

export type DiagnosticLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type DiagnosticFields = Readonly<Record<string, string | number | boolean | null | undefined>>;
export type DiagnosticSink = (level: DiagnosticLevel, area: string, explanation: string, fields?: DiagnosticFields) => void;

/** Diagnostic observers never own the operation they describe. */
export function diagnose(sink: DiagnosticSink | undefined, level: DiagnosticLevel, area: string, explanation: string, fields?: DiagnosticFields): void {
  if (!sink) return;
  try { sink(level, area, explanation, fields); } catch { /* A failed observer cannot change presentation or source work. */ }
}

const codes = new Set(["ENOENT", "EIO", "ENOSPC", "EACCES", "EPERM", "EEXIST", "EBUSY", "EMFILE", "ENFILE", "ENOTDIR", "EINVAL", "EROFS", "ELOOP", "EISDIR", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ABORT_ERR", "ESRCH",
  "invalid_header", "provider_changed", "invalid_descriptor", "invalid_source", "invalid_close",
  "busy", "profile_changed", "theme_unavailable", "profile_unavailable", "restart_required", "scope_gone",
  "invalid_request", "invalid_scope", "invalid_session", "invalid_hint", "unknown_syntax", "cancelled", "worker_gone", "queue_expired",
  "route_limit", "session_limit", "source_limit", "style_limit", "theme_limit", "state_limit", "result_limit", "scope_limit", "frame_limit", "reply_limit",
  "parser_error", "control_failed", "pipe_error", "pipe_frame", "pipe_start", "pipe_window", "shared_transport"]);
export function diagnosticError(error: unknown): string {
  try {
    if (error && typeof error === "object") {
      const code = Object.getOwnPropertyDescriptor(error, "code")?.value as unknown;
      if (typeof code === "string" && codes.has(code)) return code;
    }
    if (error instanceof TypeError) return "TypeError";
    if (error instanceof RangeError) return "RangeError";
    if (error instanceof SyntaxError) return "SyntaxError";
  } catch { /* Error inspection is also best-effort and must not invoke accessors. */ }
  return "unknown";
}

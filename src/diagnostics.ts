export type DiagnosticLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type DiagnosticFields = Readonly<Record<string, string | number | boolean | null | undefined>>;
export type RuntimeArea = 'syntax' | 'appearance' | 'terminal-colors' | 'settings' | 'git';
export type RuntimeEvent = { scope: object; operation: string } &
  ({ kind: 'failure'; area: RuntimeArea; code: string } | { kind: 'recovered' | 'released' });
export type DiagnosticSink = ((level: DiagnosticLevel, area: string, explanation: string, fields?: DiagnosticFields) => void) & {
  /** Health is delivered independently of optional diagnostic-file capture. */
  runtime?: (event: RuntimeEvent) => void;
};
export function reportRuntime(sink: DiagnosticSink | undefined, event: RuntimeEvent): void {
  try { sink?.runtime?.(event); } catch { /* Observability cannot alter the operation. */ }
}
const expectedRefusals = new Set(['busy', 'cancelled', 'queue_expired', 'provider_changed', 'restart_required',
  'profile_changed', 'profile_unavailable', 'theme_unavailable', 'scope_gone', 'scope_limit', 'source_limit',
  'style_limit', 'theme_limit', 'state_limit', 'result_limit', 'frame_limit', 'reply_limit', 'route_limit', 'session_limit']);
function noStartUnknownSyntax(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  try {
    return Object.getOwnPropertyDescriptor(error, 'code')?.value === 'unknown_syntax'
      && Object.getOwnPropertyDescriptor(error, 'execution')?.value === 'not_started';
  } catch { return false; }
}
export function unexpectedDiagnostic(error: unknown): boolean {
  return !noStartUnknownSyntax(error) && !expectedRefusals.has(diagnosticError(error));
}

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

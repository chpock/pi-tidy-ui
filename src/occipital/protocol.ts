// Shared transport errors and descriptor data; v3 decoding is in semantic-protocol.ts.
type Invalid = 'invalid_header'|'provider_changed'|'invalid_descriptor'|'invalid_source'|'invalid_close';
export class ProtocolError extends Error {
  readonly code: Invalid;
  constructor(code: Invalid) { super(`occipital ${code}`); this.code=code; }
}
export class RemoteFault extends Error {
  readonly code:string;readonly execution:'not_started'|'started';
  constructor(code: string, execution: 'not_started'|'started') { super(`occipital ${code}`);this.code=code;this.execution=execution; }
}
export interface ProfileDescription { readonly id:string;readonly label:string;readonly fingerprint:string }
export interface Limits {
  request_bytes:number;reply_bytes:number;control_request_bytes:number;control_reply_bytes:number;
  source_bytes:number;line_bytes:number;batch_sources:number;queue_wait_ms:number;
  state_pool_bytes:number;leases:number;leases_per_route:number;runs:number;
  idle_ms:number;age_ms:number;quantum_ms:number;data_per_route:number;control_per_route:number;routes:number;workers:number;
}
export interface Description {
  instance:string;assets:string;backend_version:string;catalogue_revision:number;
  profiles:readonly ProfileDescription[];diagnostic:string|null;limits:Limits;
  runtime:Readonly<Record<'pid'|'routes'|'leases'|'data_bytes'|'data_jobs'|'queued'|'control_bytes'|'control_jobs',number>>;
}
export interface Counters { committed_line_calls:number;committed_line_bytes:number;tail_calls:number;tail_bytes:number }

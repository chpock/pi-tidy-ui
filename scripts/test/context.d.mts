export interface PreparedInputs {
  schema: 1;
  inputsPath: string;
  preparation: string;
  runRoot: string;
  source: { root: string; commit: string; tree: string; nativeTree: string };
  node: { path: string; version: string };
  tools: Record<string, string>;
  pi: { root: string; version: string; cli: string; lock: string; lockSha256: string; packages: { name: string; version: string; path: string; sha256: string }[] };
  native?: { path: string; bytes: number; sha256: string; version: string; commit: string; nativeTree: string; target: string };
  sharedHost?: { path: string; sha256: string };
  integration?: { root: string; manifest: string };
  systemRoot?: string;
}
export function digest(bytes: Uint8Array): string;
export function readInputs(path?: string): PreparedInputs;
export function toolPath(name: string, inputs?: PreparedInputs): string;
export function childEnv(root: string, extra?: NodeJS.ProcessEnv, inputs?: PreparedInputs): NodeJS.ProcessEnv;
export function validateNative(inputs: PreparedInputs): NonNullable<PreparedInputs['native']>;
export function validateHost(inputs: PreparedInputs, runtime?: boolean): void;

export type NativeTarget = 'linux-x64-gnu' | 'linux-arm64-gnu' | 'darwin-x64' | 'darwin-arm64' | 'windows-x64-msvc' | 'windows-arm64-msvc';
export interface NativeReleaseDeclaration {
  version: string;
  artifacts: readonly { target: NativeTarget; sha256: string; url: string; maxBytes: number }[];
}

// Release preparation fills this declaration only in the disposable npm package.
// Source version 0.0.0 never uses a published pin, cache, download or shared daemon.
export const NATIVE_RELEASE: NativeReleaseDeclaration | undefined = undefined;

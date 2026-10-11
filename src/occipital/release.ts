export type NativeTarget = 'linux-x64-gnu' | 'linux-arm64-gnu' | 'darwin-x64' | 'darwin-arm64' | 'windows-x64-msvc' | 'windows-arm64-msvc';
export interface NativeReleaseDeclaration {
  version: string;
  artifacts: readonly { target: NativeTarget; sha256: string; url: string; maxBytes: number }[];
}

// The release gate requires published, verified payloads before extension references.
// This checkout has no adopted standalone release yet; shared service remains usable.
export const NATIVE_RELEASE: NativeReleaseDeclaration | undefined = undefined;

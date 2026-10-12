export type NativeTarget = 'linux-x64-gnu' | 'linux-arm64-gnu' | 'darwin-x64' | 'darwin-arm64' | 'windows-x64-msvc' | 'windows-arm64-msvc';
export interface NativeReleaseDeclaration {
  version: string;
  artifacts: readonly { target: NativeTarget; sha256: string; url: string; maxBytes: number }[];
}

// Verified published artifacts; this daemon pin is independent of extension tags.
export const NATIVE_RELEASE: NativeReleaseDeclaration | undefined = {
  version: '0.1.3',
  artifacts: [
    {
      target: 'linux-x64-gnu',
      sha256: '8fb18025967bad2dd9e4e7bac4d3d3d99964e0a026550232a09a3c4f64804dfc',
      maxBytes: 4066816,
      url: 'https://github.com/chpock/pi-tidy-ui/releases/download/occipital-v0.1.3/occipital-v0.1.3-linux-x64-gnu',
    },
    {
      target: 'linux-arm64-gnu',
      sha256: '190df907bdf3840502a68b5505557a3c58331cb378c300b71da82c717b1ed60a',
      maxBytes: 3826200,
      url: 'https://github.com/chpock/pi-tidy-ui/releases/download/occipital-v0.1.3/occipital-v0.1.3-linux-arm64-gnu',
    },
    {
      target: 'darwin-x64',
      sha256: 'b3ddb7eb2cb0b7003c1c785811c49dd35e22fc59a7c3430e0078c77befc85461',
      maxBytes: 3885216,
      url: 'https://github.com/chpock/pi-tidy-ui/releases/download/occipital-v0.1.3/occipital-v0.1.3-darwin-x64',
    },
    {
      target: 'darwin-arm64',
      sha256: 'ccdfd74e0baa1938a72d2cd2c9bb78e52ce10e709b9e0d64aa3bab18cb638d40',
      maxBytes: 3774656,
      url: 'https://github.com/chpock/pi-tidy-ui/releases/download/occipital-v0.1.3/occipital-v0.1.3-darwin-arm64',
    },
    {
      target: 'windows-x64-msvc',
      sha256: '9daeebab05d4e5efa076e11cba4dee4e9f6363bc1c1c125a6d08ef8701ce67b2',
      maxBytes: 4418560,
      url: 'https://github.com/chpock/pi-tidy-ui/releases/download/occipital-v0.1.3/occipital-v0.1.3-windows-x64-msvc.exe',
    },
    {
      target: 'windows-arm64-msvc',
      sha256: '4162bd54ee1264b06cad608187da832bbd4eb1ad774bfc0e7a43528cdd9fa91d',
      maxBytes: 4089344,
      url: 'https://github.com/chpock/pi-tidy-ui/releases/download/occipital-v0.1.3/occipital-v0.1.3-windows-arm64-msvc.exe',
    },
  ],
};

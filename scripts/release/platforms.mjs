export const platforms = Object.freeze([
  {target:'linux-x64-gnu',runner:'ubuntu-24.04',rust:'x86_64-unknown-linux-gnu',os:'linux',cpu:'x64',libc:'glibc',executable:'occipital'},
  {target:'linux-arm64-gnu',runner:'ubuntu-24.04-arm',rust:'aarch64-unknown-linux-gnu',os:'linux',cpu:'arm64',libc:'glibc',executable:'occipital'},
  {target:'darwin-x64',runner:'macos-15-intel',rust:'x86_64-apple-darwin',os:'darwin',cpu:'x64',executable:'occipital'},
  {target:'darwin-arm64',runner:'macos-14',rust:'aarch64-apple-darwin',os:'darwin',cpu:'arm64',executable:'occipital'},
  {target:'windows-x64-msvc',runner:'windows-2022',rust:'x86_64-pc-windows-msvc',os:'win32',cpu:'x64',executable:'occipital.exe'},
  {target:'windows-arm64-msvc',runner:'windows-11-arm',rust:'aarch64-pc-windows-msvc',os:'win32',cpu:'arm64',executable:'occipital.exe',enabled:false},
].map(Object.freeze));

export const candidateTargets = Object.freeze(Object.fromEntries(platforms.map(({target,os,cpu,libc,executable}) => [target,Object.freeze({os,cpu,...(libc?{libc}:{}),executable})])));

export function enabledTargets({windowsArm64 = false} = {}) {
  if (typeof windowsArm64 !== 'boolean') throw new Error('Windows ARM64 switch must be boolean');
  return platforms.filter(platform => platform.enabled !== false || windowsArm64).map(platform => platform.target);
}

export function validateTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0 || targets.some(target => !Object.hasOwn(candidateTargets,target)) || new Set(targets).size !== targets.length) throw new Error('Expected nonempty unique known native targets');
  return [...targets];
}

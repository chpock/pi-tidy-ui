import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { candidateTargets, daemonVersion, executableDigest, stageRelease } from './native-release.mjs';
import { prepareNotices } from './native-notices.mjs';
import { releaseRef, npmReleaseTag } from './version.mjs';
import { enabledTargets, validateTargets } from './platforms.mjs';

const run = promisify(execFile);
export function assetName(version, target) {
  if (!Object.hasOwn(candidateTargets, target)) throw new Error('Unknown native target');
  return `occipital-v${version}-${target}${candidateTargets[target].os === 'win32' ? '.exe' : ''}`;
}
export const artifactName = (version, target) => `occipital-v${version}-${target}`;
const json = async path => JSON.parse(await readFile(path, 'utf8'));
function identity(repository, commit) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected repository and exact commit SHA');
}
function url(repository, tag, version, target) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName(version, target))}`;
}

export function windowsRuntimeImports(output) {
  const imports = [...output.matchAll(/^\s+Name:\s+([^\r\n]+\.dll)\s*$/gim)].map(match => match[1].trim());
  if (!imports.length) throw new Error('Windows executable inspection returned no DLL imports');
  const runtime = imports.filter(name => /^(?:(?:vcruntime|msvcp|msvcr|concrt)\d[^.]*|ucrtbase|api-ms-win-crt-[^.]+)\.dll$/i.test(name));
  if (runtime.length) throw new Error(`Windows executable depends on runtime DLL: ${runtime.join(', ')}`);
  return imports;
}

export async function verifyWindowsRuntime(binary, execute = run) {
  const options = { timeout: 30000 };
  const { stdout: sysroot } = await execute('rustc', ['--print', 'sysroot'], options);
  const { stdout: version } = await execute('rustc', ['-vV'], options);
  const host = version.match(/^host: (\S+)$/m)?.[1];
  if (!host) throw new Error('Cannot determine Rust host for Windows executable inspection');
  const tool = join(sysroot.trim(), 'lib', 'rustlib', host, 'bin', `llvm-readobj${process.platform === 'win32' ? '.exe' : ''}`);
  const { stdout } = await execute(tool, ['--coff-imports', binary], options);
  const imports = windowsRuntimeImports(stdout);
  console.log(`Windows static-runtime check passed: ${imports.join(', ')}`);
}

export function linuxRuntimeVersions(output) {
  const required = [];
  for (const match of output.matchAll(/^\s+0x[\da-f]+:\s+Name:\s+(GLIBC_\S+)\s+Flags:\s+(\S+)\s+Version:\s+\d+\s*$/gim)) {
    if (match[2] === 'WEAK') continue;
    const version = /^GLIBC_(\d+)\.(\d+)(?:\.(\d+))?$/.exec(match[1]);
    if (match[2] !== 'none' || !version) throw new Error(`Unsupported glibc requirement for the 2.28 baseline: ${match[1]}`);
    const major = Number(version[1]), minor = Number(version[2]), patch = Number(version[3] ?? 0);
    if (major > 2 || (major === 2 && (minor > 28 || (minor === 28 && patch > 0)))) {
      throw new Error(`Executable exceeds glibc 2.28: ${match[1]}`);
    }
    required.push(match[1].slice('GLIBC_'.length));
  }
  if (!required.length) throw new Error('Linux executable inspection returned no required glibc version requirements');
  return required;
}

export async function verifyLinuxRuntime(binary, execute = run) {
  const { stdout } = await execute('readelf', ['--wide', '--version-info', binary], { timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  const versions = linuxRuntimeVersions(stdout);
  console.log(`GNU glibc 2.28 check passed: ${[...new Set(versions)].join(', ')}`);
}

/** Runs only after the native job builds/tests its stamped version. */
export async function stageCI({ root, target, binary, repository, commit, output, targets = enabledTargets() }) {
  targets = validateTargets(targets);
  identity(repository, commit);
  if (!targets.includes(target)) throw new Error('Unknown native target');
  if (candidateTargets[target].os === 'win32') await verifyWindowsRuntime(binary);
  if (candidateTargets[target].os === 'linux') await verifyLinuxRuntime(binary);
  const version = await daemonVersion(root);
  const result = await run(binary, ['--version'], { timeout: 30000 });
  if (result.stdout.trim() !== `occipital ${version}`) throw new Error('Executable version differs from stamped Cargo version');
  const { stdout } = await run('cargo', ['metadata', '--locked', '--offline', '--format-version', '1'], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  const supplements = (await json(join(root, 'scripts/release/notices/supplements.json'))).map(item => ({ ...item, file: join(root, 'scripts/release/notices', item.file) }));
  const notices = join(dirname(output), `native-notices-${target}`);
  const report = await prepareNotices({ metadata: JSON.parse(stdout), output: notices, supplements });
  if (report.gaps.length) throw new Error(report.gaps.join('\n'));
  await stageRelease({ root, output, targets: [target], input: { notice: join(notices, 'NOTICE'), artifacts: [{ target, path: binary,
    url: url(repository, 'occipital-v' + version, version, target) }] } });
  await rename(notices, join(output, 'notices'));
  await writeFile(join(output, 'build-info.json'), JSON.stringify({ commit, version, target }, null, 2) + '\n');
}

/** No remote APIs: every selected target must have exact-tag, exact-commit CI outputs. */
export async function assembleRelease({ directory, tag, repository, commit, output, targets = enabledTargets() }) {
  targets = validateTargets(targets);
  identity(repository, commit);
  const release = releaseRef('refs/tags/' + tag);
  if (release.product !== 'occipital') throw new Error('Only occipital tags create a native release');
  const prepared = [], noticeGroups = [], metadata = { version: release.version, artifacts: [] };
  let license;
  for (const target of targets) {
    const root = join(directory, artifactName(release.version, target)), info = await json(join(root, 'build-info.json'));
    if (info.commit !== commit || info.version !== release.version || info.target !== target) throw new Error('CI artifact commit/version/target differs');
    const notices = await json(join(root, 'notices/notice-sources.json'));
    if (!Array.isArray(notices.gaps) || notices.gaps.length || !Array.isArray(notices.inventory) || !notices.inventory.length) throw new Error('Unresolved native notice inventory');
    const staged = await json(join(root, 'native-release.staged.json')), record = staged.artifacts?.[0];
    if (staged.version !== release.version || staged.artifacts?.length !== 1 || record?.target !== target || record.url !== url(repository, tag, release.version, target)) throw new Error('Unexpected staged release metadata');
    const name = assetName(release.version, target), path = join(root, 'assets', name), digest = await executableDigest(path);
    if (digest.sha256 !== record.sha256 || digest.maxBytes !== record.maxBytes) throw new Error('CI executable differs from its checksum/size');
    const notice = await readFile(join(root, 'assets/NOTICE')), own = await readFile(join(root, 'assets/LICENSE'));
    if (!notice.toString('utf8').trim() || !own.toString('utf8').trim() || (license && !license.equals(own))) throw new Error('Missing or inconsistent release notices');
    license = own;
    const group = noticeGroups.find(item => item.bytes.equals(notice));
    if (group) group.targets.push(target);
    else noticeGroups.push({ bytes: notice, targets: [target] });
    prepared.push({ name, path }); metadata.artifacts.push(record);
  }
  // Refuse an existing output instead of mixing this run with partial older files.
  await mkdir(output);
  for (const artifact of prepared) await copyFile(artifact.path, join(output, artifact.name));
  const notices = [Buffer.from('Occipital third-party notices for all release platforms.\nIdentical platform inventories are included once; every distinct inventory is preserved below.\n')];
  for (const group of noticeGroups) notices.push(Buffer.from(`\n===== Targets: ${group.targets.join(', ')} =====\n\n`), group.bytes, Buffer.from('\n'));
  await writeFile(join(output, 'NOTICE'), Buffer.concat(notices));
  await writeFile(join(output, 'LICENSE'), license);
  await writeFile(join(output, 'native-release.json'), JSON.stringify(metadata, null, 2) + '\n');
  const sums = [];
  for (const name of (await readdir(output)).sort()) sums.push(`${createHash('sha256').update(await readFile(join(output, name))).digest('hex')}  ${name}\n`);
  await writeFile(join(output, 'SHA256SUMS'), sums.join(''));
  return metadata;
}

/** Reuse an existing release only after comparing every already-admitted asset; never repair it. */
export async function publishGitHubRelease({root,directory,tag,repository,commit,env=process.env,execute=run}) {
  identity(repository,commit);
  const release=npmReleaseTag(tag);
  if(release.product!=='occipital'||env.GITHUB_ACTIONS!=='true'||env.GITHUB_EVENT_NAME!=='push'||env.GITHUB_REF!=='refs/tags/'+tag
    ||env.GITHUB_REPOSITORY!==repository||env.GITHUB_SHA!==commit||!env.GH_TOKEN)throw Error('GitHub publication requires the exact authenticated push-tag source');
  const options={cwd:root,env,timeout:30000,maxBuffer:8*1024*1024};
  for(const revision of ['HEAD',`refs/tags/${tag}^{commit}`]){
    const result=await execute('git',['rev-parse','--verify','--end-of-options',revision],options);
    if(result.stdout.trim()!==commit)throw Error('GitHub publication source/tag commit differs');
  }
  const names=(await readdir(directory)).sort(),files=new Map();
  for(const required of ['native-release.json','NOTICE','LICENSE','SHA256SUMS'])if(!names.includes(required))throw Error('Missing admitted release assets');
  for(const name of names)files.set(name,await readFile(join(directory,name)));
  let lookup;
  try{lookup=await execute('gh',['api','--include',`repos/${repository}/releases/tags/${encodeURIComponent(tag)}`],options);}
  catch(error){if(!/^HTTP\/[\d.]+\s+\d{3}\b/.test(error.stdout??''))throw error;lookup=error;}
  const text=lookup.stdout.replace(/\r\n/g,'\n'),status=/^HTTP\/[\d.]+\s+(\d{3})\b/.exec(text),split=text.indexOf('\n\n');
  if(!status||split<0)throw Error('Invalid GitHub release lookup response');
  if(status[1]==='404'){
    const args=['release','create',tag,...names.map(name=>join(directory,name)),'--repo',repository,'--verify-tag','--draft',
      '--title',`Occipital ${release.version}`,'--notes','Occipital-only release. Verified raw executables, notices, checksums and native-release.json. Native npm publication follows in the same CI pipeline.'];
    if(release.prerelease)args.push('--prerelease');
    await execute('gh',args,{...options,timeout:0});await execute('gh',['release','edit',tag,'--repo',repository,'--draft=false'],{...options,timeout:0});
    return {status:'published',assets:names.length};
  }
  if(status[1]!=='200')throw Error('GitHub release lookup failed: HTTP '+status[1]);
  const published=JSON.parse(text.slice(split+2));
  if(published.tag_name!==tag||published.draft!==false||published.prerelease!==release.prerelease||!Array.isArray(published.assets))throw Error('Existing release is not the exact completed publication');
  const remote=published.assets.map(asset=>asset.name).sort();
  if(JSON.stringify(remote)!==JSON.stringify(names)||new Set(published.assets.map(asset=>asset.id)).size!==names.length)throw Error('Existing release asset inventory differs');
  for(const asset of published.assets)if(!Number.isSafeInteger(asset.id)||asset.id<=0||asset.size!==files.get(asset.name).length)throw Error('Existing release asset size/identity differs');
  const temporary=await mkdtemp(join(dirname(directory),'release-existing-'));
  try{
    await execute('gh',['release','download',tag,'--repo',repository,'--dir',temporary,'--pattern','*'],{...options,timeout:0});
    if(JSON.stringify((await readdir(temporary)).sort())!==JSON.stringify(names))throw Error('Downloaded release asset inventory differs');
    for(const[name,bytes]of files)if(!bytes.equals(await readFile(join(temporary,name))))throw Error('Existing published release bytes differ: '+name);
  }finally{await rm(temporary,{recursive:true,force:true});}
  return {status:'already-published',assets:names.length};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, ...args] = process.argv.slice(2), root = resolve(import.meta.dirname, '../..');
  const targets = args[3] === undefined ? undefined : JSON.parse(args[3]);
  if (mode === 'stage' && (args.length === 3 || args.length === 4)) await stageCI({ root, target: args[0], binary: resolve(args[1]), output: resolve(args[2]), repository: process.env.GITHUB_REPOSITORY, commit: process.env.SOURCE_COMMIT, targets });
  else if (mode === 'assemble' && (args.length === 3 || args.length === 4)) await assembleRelease({ directory: resolve(args[0]), tag: args[1], output: resolve(args[2]), repository: process.env.GITHUB_REPOSITORY, commit: process.env.SOURCE_COMMIT, targets });
  else if(mode==='publish'&&args.length===2) console.log(JSON.stringify(await publishGitHubRelease({root,directory:resolve(args[1]),tag:args[0],repository:process.env.GITHUB_REPOSITORY,commit:process.env.GITHUB_SHA})));
  else throw new Error('Usage: native-ci.mjs publish TAG ADMITTED-DIR | stage TARGET BINARY NEW-DIR [TARGETS-JSON] | assemble ARTIFACTS TAG NEW-DIR [TARGETS-JSON] (GITHUB_REPOSITORY, SOURCE_COMMIT required)');
}

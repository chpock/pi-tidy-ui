import { readFileSync } from 'node:fs';
import { enabledTargets, platforms } from '../release/platforms.mjs';
import { parseVersion } from '../../src/occipital/version.ts';

const packageManifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
export const MINIMUM_PI = packageManifest.devDependencies['@earendil-works/pi-coding-agent'];
export const NODE_VERSIONS = Object.freeze(['22.19.0','26.7.0']);
export const CLI_SHARDS = 4;

const packageName = '@earendil-works/pi-coding-agent';
const metadataURL = 'https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest';
const profilesFor = pis => NODE_VERSIONS.flatMap(node => pis.map(pi => ({node,pi})));
const defaultFetchLatest = (url, options) => fetch(url, options);
const optionNames = new Set(['eventName','ref','sha','windowsArm64','fetchLatest']);

function triggerKind(eventName, ref) {
  if (!['push','pull_request','workflow_dispatch','schedule'].includes(eventName)) throw new Error('Unsupported CI event');
  if (typeof ref !== 'string' || !ref.startsWith('refs/') || /[\x00-\x20\x7f~^:?*\[\\]/.test(ref) ||
      ref.includes('..') || ref.includes('@{') || ref.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new Error('Expected a valid full CI ref');
  }
  if (eventName === 'pull_request') {
    if (!/^refs\/pull\/[1-9][0-9]*\/merge$/.test(ref)) throw new Error('Expected a pull request merge ref');
    return 'ordinary';
  }
  if (eventName === 'schedule') {
    if (ref !== 'refs/heads/main') throw new Error('Expected main branch ref for nightly CI');
    return 'nightly';
  }
  if (ref.startsWith('refs/heads/')) {
    if (eventName === 'push' && ref !== 'refs/heads/main') throw new Error('Expected main branch ref for push CI');
    return 'ordinary';
  }
  const tag = /^refs\/tags\/(pi-tidy-ui|occipital)-v(.+)$/.exec(ref);
  if (!tag || !parseVersion(tag[2])) throw new Error('Expected a valid release tag ref');
  if (eventName !== 'push') return 'ordinary';
  return tag[1] === 'occipital' ? 'occipital-release' : 'extension-release';
}

function nativePlan(kind, windowsArm64) {
  const nightly = kind === 'nightly';
  const consumerNodes = kind === 'ordinary' ? [NODE_VERSIONS[0]] : NODE_VERSIONS;
  const enabled = new Set(enabledTargets({windowsArm64}));
  const matrix = platforms.filter(row => enabled.has(row.target) && (!nightly || row.target === 'linux-x64-gnu'))
    .map(({target,runner,rust,executable}) => ({target,runner,rust,executable}));
  const host = matrix.filter(row => row.target === 'linux-x64-gnu');
  const expand = rows => nightly ? [] : rows.flatMap(row => consumerNodes.map(node => ({...row,node})));
  const remaining = matrix.filter(row => row.target !== 'linux-x64-gnu').map(row => ({...row,consumerMatrix:expand([row])}));
  return {matrix,host,remaining,hostConsumers:expand(host),targets:matrix.map(row => row.target)};
}

/** fetchLatest has the standard fetch(URL, options) → Response interface. No source/diff inputs are accepted. */
export async function buildCIPlan(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Expected CI plan options');
  for (const key of Object.keys(options)) if (!optionNames.has(key)) throw new Error(`Unsupported CI plan option: ${key}`);
  const {eventName,ref,sha,windowsArm64 = false,fetchLatest = defaultFetchLatest} = options;
  const kind = triggerKind(eventName,ref);
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha) || /^0+$/.test(sha)) throw new Error('Expected exact nonzero commit SHA');
  if (typeof windowsArm64 !== 'boolean') throw new Error('Windows ARM64 switch must be boolean');
  if (typeof fetchLatest !== 'function') throw new Error('Expected fetchLatest function');
  const nightly = kind === 'nightly', daemon = kind === 'occipital-release', extension = kind === 'extension-release';
  let latest = null, resolvedAt = null;
  if (!daemon) {
    const response = await fetchLatest(metadataURL,{redirect:'error',signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error('Pi latest metadata HTTP status ' + response.status);
    const metadata = await response.json();
    if (metadata?.name !== packageName) throw new Error('Unexpected Pi latest package identity');
    const parsed = parseVersion(metadata.version);
    if (!parsed || metadata.version.includes('+')) throw new Error('Expected an exact npm Pi latest version');
    const actual = metadata.version.split('-')[0].split('.').map(BigInt), minimum = MINIMUM_PI.split('.').map(BigInt);
    const comparison = actual.findIndex((part, index) => part !== minimum[index]);
    const belowMinimum = comparison === -1 ? Boolean(parsed.prerelease) : actual[comparison] < minimum[comparison];
    if (belowMinimum) throw new Error('Pi latest is below minimum ' + MINIMUM_PI);
    latest = metadata.version;
    resolvedAt = new Date().toISOString();
  }
  const profiles = daemon ? [] : profilesFor(nightly ? [latest] : [...new Set([MINIMUM_PI,latest])]);
  const native = nativePlan(kind,windowsArm64);
  const cliProfiles = profiles.flatMap(profile => kind === 'ordinary' && (profile.node !== NODE_VERSIONS[0] || profile.pi !== latest)
    ? [{...profile,coverage:'compatibility'}]
    : Array.from({length:CLI_SHARDS}, (_, index) => ({...profile,coverage:'complete',shard:`${index + 1}/${CLI_SHARDS}`})));
  return {
    kind,sourceRef:sha,piSelection:{minimum:MINIMUM_PI,latest,resolvedAt},
    profiles,sdkSuite:daemon ? null : nightly ? 'compatibility' : 'unit',
    cliProfiles,
    native,delivery:!nightly,deliveryProfiles:nightly ? [] : profilesFor([MINIMUM_PI]),
    daemonRegressionProfiles:daemon ? profilesFor([MINIMUM_PI]) : [],
    release:daemon || extension,publishedConsumer:extension,preparedPack:extension,daemonRelease:daemon,daemonNpm:daemon,extensionRelease:extension,
    requiredBranches:{
      nativeHost:true,nativeRemaining:native.remaining.length > 0,nativeHostConsumers:native.hostConsumers.length > 0,
      sdk:!daemon,cli:!daemon,delivery:!nightly,daemonRegressions:daemon,publishedConsumer:extension,preparedPack:extension,daemonRelease:daemon,daemonNpm:daemon,extensionRelease:extension,
    },
  };
}

/** Map actual Actions job results to the plan's logical branch names. Required matrix branches must aggregate every row. */
export function validateCIResults(plan, statuses) {
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return false;
  if (Object.keys(statuses).some(key => !Object.hasOwn(plan.requiredBranches,key))) return false;
  return Object.entries(plan.requiredBranches).every(([key, required]) => {
    const status = Object.hasOwn(statuses,key) ? statuses[key] : undefined;
    return status === 'success' || !required && (status == null || status === 'skipped');
  });
}

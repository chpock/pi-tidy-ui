// Routing is a conservative contract default, not semantic impact analysis.
// The catalogue, rather than this table, owns test membership and capabilities.
import { execFileSync } from 'node:child_process';
import { featureNames, testEntries } from './catalog.mjs';

export const groups = featureNames;
const product = groups.filter(name => !['native','shared','profile','harness','delivery'].includes(name));
const ui = ['summaries','bash','edit','write','user','queued','editor','footer','layout','activity'];
const nodes = ['22.19.0','26.7.0'], pis = ['1.0.0','1.2.0'];
const unique = values => [...new Set(values)];
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const requireSHA = value => { if (!sha(value)) throw new Error('Expected exact commit SHA'); return value; };
const names = value => {
  if (!Array.isArray(value) || value.some(name => !groups.includes(name)) || new Set(value).size !== value.length) throw new Error('Unknown or duplicate feature group');
  return value;
};

const modules = {
  'bash-card':['bash'], 'file-card':['edit','write'], 'user-card':['user'], 'queued-card':['queued'],
  'editor-card':['editor','activity'], 'editor-status':['editor','activity','footer'],
  footer:['footer'], 'git-branch':['footer'], 'summary-args':['summaries'],
  'terminal-colors':['terminal-colors'], 'session-logging':['logging'], 'debug-log':['logging'],
  'tidy-menu':['settings','editor'],
};
function classify(path) {
  const stem = path.replace(/^src\//, '').replace(/\.ts$/, '');
  if (modules[stem]) return { features:modules[stem], pi:['editor-card','editor-status','queued-card','tidy-menu'].includes(stem), node:['git-branch','session-logging','debug-log'].includes(stem) };
  if (/^src\/(card-frame|card-theme|plain-text)\.ts$/.test(path)) return { features:ui, hotspot:true };
  if (/^src\/(index|render-cache)\.ts$/.test(path)) return { features:[...product,'native','shared'], pi:true, node:true, hotspot:true };
  if (path === 'src/settings.ts') return { features:['settings','lifecycle','terminal-colors','syntax','shared'], pi:true, hotspot:true };
  if (/^src\/syntax\/(paint|runtime)\.ts$/.test(path)) return { features:['syntax','shared','bash','edit','write'], pi:true, node:true };
  if (/^src\/syntax\//.test(path)) return { features:['syntax','bash','edit','write'], pi:true, node:true };
  if (/^src\/occipital\/(protocol|ranges|limits)\.ts$/.test(path)) return { features:['syntax','native','shared'], rust:true, node:true };
  if (/^src\/occipital\/(shared|discovery|factories|profiles)\.ts$/.test(path)) return { features:['syntax','native','shared'], node:true };
  if (/^src\/occipital\/(native|release|version|bootstrap)\.ts$/.test(path)) return { features:['delivery','native'], platforms:true, node:true };
  if (/^src\/occipital\//.test(path)) return { features:['syntax','native'], node:true };
  if (/^crates\/.*\/(?:src|tests)\//.test(path)) return { features:['native','syntax'], rust:true, node:true };
  if (/^(crates\/|Cargo\.(toml|lock)$|rust-toolchain\.toml$|\.cargo\/)/.test(path)) return { features:['native','syntax'], rust:true, platforms:true, node:true };
  if (/^(package(-lock)?\.json|tsconfig\.json)$/.test(path)) return { features:groups, pi:true, node:true, platforms:true, rust:true, hotspot:true };
  if (/^(scripts\/release\/|packages\/|\.github\/workflows\/(occipital|.*release|.*publish))/.test(path)) return { features:['delivery','native'], platforms:true, node:true };
  if (/^(scripts\/test\/|\.github\/|Makefile$)/.test(path)) return { features:groups, pi:true, node:true, platforms:true, rust:true, hotspot:true };
  const entry = path.startsWith('tests/') && testEntries.find(entry => entry.file === path.slice(6));
  if (entry) return { features:[entry.owner,...entry.also] };
  const owner = path.match(/^tests\/([\w-]+)\.(?:sdk|cli)\.test\.(?:ts|mjs)$/)?.[1];
  if (owner && groups.includes(owner)) return { features:[owner] };
  if (/^tests\//.test(path)) {
    const testStem = path.replace(/^tests\//,'').replace(/\.test\.(?:ts|mjs)$/,'');
    if (modules[testStem]) return { features:modules[testStem] };
    if (/^tests\/(syntax|occipital)-/.test(path)) return { features:['syntax','native','shared'], node:true };
    return { features:groups, pi:true, node:true, platforms:true, rust:true, hotspot:true };
  }
  if (/^(docs\/|README\.md$|LICENSE$|AGENTS\.md$|\.gitignore$|\.gitattributes$)/.test(path)) return { features:[] };
  return { features:groups, pi:true, node:true, platforms:true, rust:true, hotspot:true, unknown:true };
}

export function parseScope(body) {
  const match = typeof body === 'string' && body.match(/```ci-scope\s*\n([\s\S]*?)\n```/);
  if (!match) return undefined;
  try {
    const record = JSON.parse(match[1]);
    requireSHA(record.head); names(record.features);
    if (typeof record.rationale !== 'string' || !record.rationale.trim() || record.rationale.length > 2000 || /[\x00-\x1f\x7f]/.test(record.rationale)) return undefined;
      if (record.executeConservative !== undefined && typeof record.executeConservative !== 'boolean') return undefined;
      if (record.compatibility !== undefined && !['baseline','pi','node','all'].includes(record.compatibility)) return undefined;
      return { head:record.head, features:record.features, rationale:record.rationale, executeConservative:record.executeConservative === true, compatibility:record.compatibility ?? 'baseline' };
  } catch { return undefined; }
}

// Only metadata is requested. This function never checks out or executes PR code.
export async function reviewedScopes({ api, owner, repo, pullNumber, actor, manual }) {
  const permissions = new Map();
  const authorized = async login => {
    if (!login) return false;
    if (!permissions.has(login)) {
      const result = await api('GET /repos/{owner}/{repo}/collaborators/{username}/permission', {owner,repo,username:login});
      permissions.set(login, ['admin','maintain','write'].includes(result.data.permission));
    }
    return permissions.get(login);
  };
  if (manual) return await authorized(actor) ? [{...manual, authority:{login:actor,kind:'dispatch'}}] : [];
  if (!pullNumber) return [];
  const list = async route => {
    const result = [];
    for (let page = 1;;page++) {
      const {data} = await api(route, {owner,repo,issue_number:pullNumber,pull_number:pullNumber,per_page:100,page});
      result.push(...data);
      if (data.length < 100) return result;
    }
  };
  const comments = await list('GET /repos/{owner}/{repo}/issues/{issue_number}/comments');
  const reviews = await list('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews');
  const candidates = [...comments.map(value => ({...value,kind:'comment'})), ...reviews.filter(value => ['APPROVED','COMMENTED'].includes(value.state)).map(value => ({...value,kind:'review'}))]
    .sort((a,b) => (b.submitted_at ?? b.created_at).localeCompare(a.submitted_at ?? a.created_at));
  const result = [];
  for (const value of candidates) {
    const record = parseScope(value.body);
    if (record && (value.kind !== 'review' || value.commit_id === record.head) && await authorized(value.user?.login)) result.push({...record, authority:{login:value.user.login,kind:value.kind,id:value.id}});
  }
  return result;
}

export function resolveScope({ paths, head, ref, full = false, additions = [], decisions = [], featurePlan }) {
  requireSHA(head); names(additions);
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !path || /[\x00-\x1f]/.test(path))) throw new Error('Invalid changed paths');
  const releaseKind = /^refs\/tags\/occipital-v/.test(ref) ? 'daemon' : /^refs\/tags\/pi-tidy-ui-v/.test(ref) ? 'extension' : null;
  const release = releaseKind !== null;
  if (releaseKind === 'daemon' && additions.length) throw new Error('Daemon release uses a fixed native/delivery union; additive UI features require a separate compatibility run');
  full ||= release;
  const rules = paths.map(classify), mandatory = unique(rules.filter(rule => !rule.hotspot).flatMap(rule => rule.features));
  const defaults = full ? releaseKind === 'daemon' ? ['native','delivery'] : groups : unique(rules.flatMap(rule => rule.features));
  const decision = !full && decisions.find(value => value.head === head && value.authority && parseScope('```ci-scope\n' + JSON.stringify(value) + '\n```'));
  // Base metadata cannot enumerate owners introduced by the current catalogue.
  const currentUnion = decision?.executeConservative === true && paths.includes('scripts/test/catalog.mjs');
  full ||= currentUnion;
  const pending = !full && rules.some(rule => rule.hotspot) && !decision;
  const features = unique([...(decision && !decision.executeConservative ? [...mandatory,...decision.features] : defaults),...additions]).sort();
  const plan = featurePlan(features, {baseline:false});
  const requirements = unique(plan.requirements);
  const selectedPlatform = full || features.includes('delivery') || rules.some(rule => rule.platforms && (!rule.hotspot || !decision || decision.executeConservative || features.includes('delivery')));
  const rust = full || rules.some(rule => rule.rust && (!rule.hotspot || !decision || decision.executeConservative || features.includes('native') || features.includes('delivery')));
  if (selectedPlatform) requirements.push('native','registry');
  if (rust) requirements.push('rust','native');
  const pi = full && releaseKind !== 'daemon' || rules.some(rule => rule.pi) || ['pi','all'].includes(decision?.compatibility), node = full || rules.some(rule => rule.node) || ['node','all'].includes(decision?.compatibility);
  const profiles = (node ? nodes : nodes.slice(0,1)).flatMap(node => (pi ? pis : pis.slice(0,1)).map(pi => ({node,pi})));
  const combineBaseline = !full && !pending && !requirements.some(name => ['native','shared','integration','registry','rust'].includes(name));
  const baselineFeatures = combineBaseline ? features : [];
  const affectedProfiles = profiles.filter(profile => !(combineBaseline && profile.node === nodes[0] && profile.pi === pis[0]));
  return {
    schema:1, head, ref, full, selection:full ? 'current-source-fixed-union' : 'feature-groups', release, releaseKind, publishedConsumer:releaseKind === 'extension', status:pending ? 'scope-decision-required' : 'ready',
    features, defaults:defaults.slice().sort(), mandatory:mandatory.sort(), additions,
    baselineFeatures, affectedProfiles, requestedCompatibility:decision?.compatibility ?? 'baseline',
    runAffected: features.length > 0 && affectedProfiles.length > 0 && (!full || releaseKind === 'daemon'),
    capabilities:Object.fromEntries(['native','shared','integration','registry','rust'].map(name => [name,requirements.includes(name)])),
    platforms:selectedPlatform ? 'all' : 'host-only', consumers:selectedPlatform,
    profiles, rationale:currentUnion ? 'Approved conservative catalogue evolution; execute current-source fixed unions. ' + decision.rationale : full ? releaseKind === 'daemon' ? 'Full independent daemon release: native/delivery on both Nodes and all six targets.' : 'Full compatibility/extension-release union cannot be narrowed.' : decision?.rationale ?? 'Conservative path defaults; paths are not proof of semantic impact.',
    productExclusion:releaseKind === 'daemon' ? 'Extension SDK/CLI and public extension-delivery checks are not daemon-release obligations.' : null,
    routes:paths.map((path,index) => ({path,features:rules[index].features,reviewRequired:rules[index].hotspot === true})),
    ignoredDecisions:decisions.filter(value => value.head !== head).map(value => ({head:value.head,authority:value.authority,reason:'stale-head'})),
    authority:decision?.authority ?? {kind:'default'},
    obligations:pending ? ['Maintainer scope decision required before executing the conservative broad union.'] : [],
    unknownPaths:paths.filter((path,index) => rules[index].unknown),
  };
}

export function nativeTargets(mode = 'all', ref = '') {
  if (!['all','host-only','windows-only'].includes(mode)) throw new Error('Unknown native target scope');
  const targets = [
    {target:'linux-x64-gnu',runner:'ubuntu-24.04',rust:'x86_64-unknown-linux-gnu',executable:'occipital'},
    {target:'linux-arm64-gnu',runner:'ubuntu-24.04-arm',rust:'aarch64-unknown-linux-gnu',executable:'occipital'},
    {target:'darwin-x64',runner:'macos-15-intel',rust:'x86_64-apple-darwin',executable:'occipital'},
    {target:'darwin-arm64',runner:'macos-14',rust:'aarch64-apple-darwin',executable:'occipital'},
    {target:'windows-x64-msvc',runner:'windows-2022',rust:'x86_64-pc-windows-msvc',executable:'occipital.exe'},
    {target:'windows-arm64-msvc',runner:'windows-11-arm',rust:'aarch64-pc-windows-msvc',executable:'occipital.exe'},
  ];
  if (mode === 'all' || /^refs\/tags\/(pi-tidy-ui|occipital)-v/.test(ref)) return targets;
  if (mode === 'windows-only') {
    if (!/^refs\/heads\/.+/.test(ref)) throw new Error('Windows diagnostic requires a branch ref');
    return targets.filter(row => row.target.startsWith('windows-'));
  }
  return targets.slice(0,1);
}

export function nativePlan(mode = 'all', ref = '', consumers = true) {
  if (typeof consumers !== 'boolean') throw new Error('Native consumer selection must be boolean');
  return {matrix:nativeTargets(mode,ref),packaging:ref.startsWith('refs/tags/') || consumers && mode !== 'windows-only'};
}

export function changedPaths(base, head, git = (args) => execFileSync('git', args, {encoding:'utf8', maxBuffer:8 * 1024 * 1024}), pullRequest = false) {
  requireSHA(base); requireSHA(head);
  if (/^0{40}$/.test(base)) return git(['ls-tree','-r','--name-only','-z',head]).split('\0').filter(Boolean);
  if (pullRequest) base = requireSHA(git(['merge-base',base,head]).trim());
  // --no-renames includes both sides of renames, preserving the removed owner's obligations.
  return git(['diff','--no-renames','--name-only','-z',base,head]).split('\0').filter(Boolean);
}

export async function githubScope({ api, eventName, payload, ref, commit, actor, inputs = {}, featurePlan, git }) {
  const pr = payload.pull_request;
  const head = requireSHA(pr?.head.sha ?? commit);
  const {owner, name:repo} = payload.repository;
  const ownerName = typeof owner === 'string' ? owner : owner.login;
  if (eventName === 'workflow_dispatch' && (inputs['windows-only'] === true || inputs['windows-only'] === 'true')) {
    if (!/^refs\/heads\/.+/.test(ref)) throw new Error('Windows diagnostic requires a branch ref');
    if (inputs.full !== false && inputs.full !== 'false') throw new Error('Windows diagnostic requires full=false');
    if (inputs['scope-head'] !== head) throw new Error('Windows diagnostic requires exact tested HEAD');
    if (inputs.features || inputs['add-features'] || inputs.compatibility && inputs.compatibility !== 'baseline' || inputs['execute-conservative'] === true || inputs['execute-conservative'] === 'true') throw new Error('Windows diagnostic cannot combine feature or compatibility selections');
    const rationale = 'Explicit manual Windows consumer diagnostic; not full feature, compatibility or release acceptance.';
    const [decision] = await reviewedScopes({api,owner:ownerName,repo,actor,manual:{head,features:[],rationale}});
    if (!decision) throw new Error('Windows diagnostic requires maintainer authority');
    return {...resolveScope({paths:[],head,ref,featurePlan}),selection:'windows-consumer-diagnostic',base:null,
      capabilities:{native:true,shared:false,integration:false,registry:true,rust:true},platforms:'windows-only',consumers:true,
      profiles:nodes.map(node=>({node,pi:pis[0]})),rationale,authority:decision.authority,
      productExclusion:'This diagnostic does not perform product SDK/CLI, Linux/macOS, packaging or release acceptance.'};
  }
  const full = /^refs\/tags\/(pi-tidy-ui|occipital)-v/.test(ref) || eventName === 'workflow_dispatch' && inputs.full !== false && inputs.full !== 'false';
  if (eventName === 'workflow_dispatch' && !full && inputs['scope-head'] !== head) throw new Error('Manual feature scope requires exact tested HEAD');
  const base = full ? undefined : requireSHA(pr?.base.sha ?? (eventName === 'push' ? payload.before : inputs['base-sha']));
  const manual = eventName === 'workflow_dispatch' && !full ? parseScope('```ci-scope\n' + JSON.stringify({head:inputs['scope-head'],features:inputs.features ? inputs.features.split(',') : [],rationale:inputs.rationale,compatibility:inputs.compatibility,executeConservative:inputs['execute-conservative'] === true || inputs['execute-conservative'] === 'true'}) + '\n```') : undefined;
  if (eventName === 'workflow_dispatch' && !full && !manual) throw new Error('Manual feature scope requires valid groups and rationale');
  const decisions = full ? [] : await reviewedScopes({api,owner:ownerName,repo,pullNumber:pr?.number,actor,manual});
  if (manual && !decisions.length) throw new Error('Manual feature scope requires maintainer authority');
  const additions = inputs['add-features'] ? names(inputs['add-features'].split(',')) : [];
  return {...resolveScope({paths:full ? [] : changedPaths(base,head,git,Boolean(pr)),head,ref,full,additions,decisions,featurePlan}),base:base ?? null};
}

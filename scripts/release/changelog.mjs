import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseVersion } from '../../src/occipital/version.ts';

export const changelogPaths = Object.freeze({
  'pi-tidy-ui': 'CHANGELOG.md',
  occipital: 'docs/occipital/CHANGELOG.md',
});

const repository = 'https://github.com/chpock/pi-tidy-ui';
const dependencyHeading = '### Occipital dependency';

function publishableVersion(version) {
  const parsed = parseVersion(version);
  if (!parsed || version === '0.0.0' || version.includes('+')) throw new Error('Expected a publishable SemVer version (not 0.0.0 or build metadata)');
  return parsed;
}

function comparePrereleaseIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return leftNumeric ? (BigInt(left) > BigInt(right) ? 1 : -1) : (left > right ? 1 : -1);
}

function comparePrereleases(left, right) {
  if (left === undefined || right === undefined) return left === right ? 0 : left === undefined ? 1 : -1;
  const a = left.split('.'), b = right.split('.');
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return comparePrereleaseIdentifiers(a[i], b[i]);
  }
  return Math.sign(a.length - b.length);
}

function compareVersions(left, right) {
  const [leftCore] = left.split('-'), [rightCore] = right.split('-');
  const a = leftCore.split('.').map(BigInt), b = rightCore.split('.').map(BigInt);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  const leftPre = left.length === leftCore.length ? undefined : left.slice(leftCore.length + 1);
  const rightPre = right.length === rightCore.length ? undefined : right.slice(rightCore.length + 1);
  return comparePrereleases(leftPre, rightPre);
}

function validDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function versionHeading(line) {
  if (line === '## [Unreleased]') return { version: 'Unreleased', date: null };
  const match = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/.exec(line);
  if (!match) throw new Error(`Invalid changelog H2 heading: ${line}`);
  publishableVersion(match[1]);
  if (!validDate(match[2])) throw new Error(`Invalid changelog date: ${match[2]}`);
  return { version: match[1], date: match[2] };
}

function openingFence(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return undefined;
  return match[1];
}

function closesFence(line, fence) {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return match && match[1][0] === fence[0] && match[1].length >= fence.length;
}

function meaningfulBody(lines) {
  return lines.join('\n').replace(/<!--[\s\S]*?(?:-->|$)/g, '').split('\n').some(line => {
    const content = line.replace(/^(?:[ \t]*>[ \t]*)*/, '');
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(content)) return false;
    if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(content)) return false;
    return content.replace(/^\s*(?:[-+*]|\d+[.)])(?:[ \t]+|$)/, '').trim().length > 0;
  });
}

function validateVersionOrder(current, version) {
  if (!current) {
    if (version !== 'Unreleased') throw new Error('Expected exactly one Unreleased entry first');
    return;
  }
  if (version === 'Unreleased') throw new Error('Expected exactly one Unreleased entry first');
  if (current.version !== 'Unreleased' && compareVersions(current.version, version) <= 0) throw new Error('Changelog versions must be strictly descending');
}

function finishEntry(scan, end) {
  const { current, lines } = scan;
  if (!current) return;
  if (current.version !== 'Unreleased' && !current.codeContent && !meaningfulBody(current.body)) throw new Error(`Empty changelog body for ${current.version}: meaningful content required`);
  const markdown = lines.slice(current.start, end).join('\n') + (end < lines.length ? '\n' : '');
  scan.entries.push({ version: current.version, date: current.date, markdown: markdown.endsWith('\n') ? markdown : markdown + '\n' });
}

function beginEntry(scan, line, index) {
  const heading = versionHeading(line);
  if (scan.seen.has(heading.version)) throw new Error(`Duplicate changelog version: ${heading.version}`);
  validateVersionOrder(scan.current, heading.version);
  finishEntry(scan, index);
  scan.seen.add(heading.version);
  scan.current = { ...heading, start: index, body: [], codeContent: false };
}

function scanFencedLine(scan, line) {
  if (closesFence(line, scan.fence)) scan.fence = undefined;
  else if (scan.current && line.trim()) scan.current.codeContent = true;
}

function scanChangelogLine(scan, line, index) {
  if (scan.fence) {
    scanFencedLine(scan, line);
    return;
  }
  scan.fence = openingFence(line);
  if (scan.fence) return;
  if (/^ {0,3}##(?:[ \t]|$)/.test(line)) {
    beginEntry(scan, line, index);
    return;
  }
  if (/^ {0,3}###[ \t]+Occipital dependency(?:[ \t]+#+)?[ \t]*$/i.test(line)) throw new Error('The Occipital dependency heading is reserved for generated release notes');
  if (scan.current) scan.current.body.push(line);
}

export function parseChangelog(text) {
  if (typeof text !== 'string') throw new TypeError('Expected changelog text as a string');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const scan = { lines, entries: [], seen: new Set(), current: undefined, fence: undefined };
  for (let index = 0; index < lines.length; index++) scanChangelogLine(scan, lines[index], index);
  if (scan.fence) throw new Error('Unclosed changelog code fence');
  if (!scan.current) throw new Error('Expected exactly one Unreleased entry first');
  finishEntry(scan, lines.length);
  return scan.entries;
}

function selectedEntry(entries, version) {
  publishableVersion(version);
  const entry = entries.find(entry => entry.version === version);
  if (!entry) throw new Error(`Changelog version not found: ${version}`);
  return entry;
}

function notesWithDependency(entry, version) {
  publishableVersion(version);
  const separator = entry.markdown.endsWith('\n\n') ? '' : '\n';
  return entry.markdown + separator + `${dependencyHeading}\n\nThis release packages Occipital [${version}](${repository}/releases/tag/occipital-v${version}). Shared services are selected by protocol compatibility, not by this packaged version.\n`;
}

export function releaseNotes(text, version, occipitalVersion) {
  const entry = selectedEntry(parseChangelog(text), version);
  return occipitalVersion === undefined ? entry.markdown : notesWithDependency(entry, occipitalVersion);
}

export function extensionChangelog(text, version, occipitalVersion) {
  const entries = parseChangelog(text), current = selectedEntry(entries, version);
  const { prerelease } = parseVersion(current.version);
  const notes = notesWithDependency(current, occipitalVersion);
  const released = entries.filter(entry => entry.version !== 'Unreleased' && compareVersions(entry.version, version) <= 0 && (prerelease || !parseVersion(entry.version).prerelease));
  if (!prerelease && released.some(entry => entry.markdown.split('\n').slice(1).some(line => line.startsWith('## ')))) {
    throw new Error('Pi treats literal column-zero H2 headings as versions even inside code; indent example headings for a stable package');
  }
  return `# pi-tidy-ui changelog\n\n[Full history](${repository}/blob/main/CHANGELOG.md).\n\n` +
    released.map(entry => entry === current ? notes : entry.markdown).join('\n');
}

export async function loadChangelog(root, product) {
  if (typeof root !== 'string' || !root) throw new TypeError('Expected a nonempty changelog root path');
  if (typeof product !== 'string' || !Object.hasOwn(changelogPaths, product)) throw new Error('Unknown changelog product');
  const text = await readFile(join(root, changelogPaths[product]), 'utf8');
  parseChangelog(text);
  return text;
}

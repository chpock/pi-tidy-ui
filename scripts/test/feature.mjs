import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { featurePlan, validateCatalogue } from './catalog.mjs';
import { readInputs, validateRequirements } from './context.mjs';
import { refreshInputs } from './prepare.mjs';
import { execute } from './run.mjs';

export async function runFeature(options, run = execute) {
  const started = performance.now();
  if (typeof options.features !== 'string') throw new Error('Supply explicit --features (empty string selects the common baseline)');
  const names = options.features === '' ? [] : options.features.split(',');
  if (!names.length && options['affected-only']) throw new Error('Empty feature selection');
  const inputPath = resolve(options.inputs ?? '.test-artifacts/harness/1.0.0/inputs.json');
  const output = resolve(options.output ?? join(dirname(inputPath), 'feature-runs', Date.now().toString()));
  const report = { schema: 1, purpose: options['affected-only'] ? 'affected-only' : 'feature-completion', features: [...new Set(names)].sort(),
    selected: { node: [], cli: [] }, requirements: [], status: 'setup-failed', stages: [] };
  mkdirSync(output, { recursive: true });
  try {
    let inputs = readInputs(inputPath);
    if (options.refresh) inputs = refreshInputs(inputPath);
    validateCatalogue(inputs.pi.root);
    const plan = featurePlan(names, { root: inputs.pi.root, baseline: !options['affected-only'] });
    if (!plan.node.length && !plan.cli.length) throw new Error('Empty feature selection');
    report.selected = { node: plan.node, cli: plan.cli }; report.requirements = plan.requirements;
    report.source = inputs.source; report.pi = inputs.pi.version; report.node = inputs.node.version;
    report.preparation = inputs.preparationStats ?? null;
    validateRequirements(inputs, plan.requirements);
    const stages = [
      ...(!options['affected-only'] || options['check-types'] ? [{ name: 'types', suite: 'check' }] : []),
      ...(plan.node.length ? [{ name: 'node', suite: 'groups', files: plan.node.join(',') }] : []),
      ...(plan.cli.length ? [{ name: 'cli', suite: 'groups', files: plan.cli.join(',') }] : []),
    ];
    for (const stage of stages) {
      const begin = performance.now(), file = join(output, stage.name + '.json');
      const result = await run({ inputs: inputPath, suite: stage.suite, files: stage.files, 'network-isolated': options['network-isolated'], output: file });
      report.stages.push({ name: stage.name, report: file, elapsedMs: performance.now() - begin, status: result.status,
        counts: result.counts, selected: result.selected });
      if (result.status !== 'passed' || (result.counts?.skipped ?? 0) > 0 || (result.counts?.todo ?? 0) > 0) {
        report.status = result.status === 'passed' ? 'incomplete' : result.status; return report;
      }
    }
    report.status = 'passed'; return report;
  } finally {
    report.elapsedMs = performance.now() - started;
    // A separately invoked preparation is reported separately, not hidden in TAP duration.
    report.totalWithRecordedPreparationMs = report.elapsedMs + (!options.refresh ? report.preparation?.elapsedMs ?? 0 : 0);
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({ options: {
    inputs: { type: 'string' }, features: { type: 'string' }, output: { type: 'string' }, refresh: { type: 'boolean' },
    'affected-only': { type: 'boolean' }, 'check-types': { type: 'boolean' }, 'network-isolated': { type: 'boolean' },
  } });
  const result = await runFeature(values); if (result.status !== 'passed') process.exitCode = 1;
}

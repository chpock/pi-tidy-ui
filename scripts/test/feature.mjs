import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { featurePlan, validateCatalogue } from './catalog.mjs';
import { readInputs, validateRequirements } from './context.mjs';
import { refreshInputs } from './prepare.mjs';
import { execute } from './run.mjs';
import { appendProgress, resetProgressFile, writeReport } from './progress.mjs';

function classifiedChildFailure(path) {
  try {
    const child = JSON.parse(readFileSync(path, 'utf8'));
    if (['setup-failed', 'harness-failed', 'failed', 'incomplete'].includes(child.status)) return child;
  } catch {}
  return null;
}

export async function runFeature(options, run = execute) {
  const started = performance.now();
  if (typeof options.features !== 'string') throw new Error('Supply explicit --features (empty string selects the common baseline)');
  const names = options.features === '' ? [] : options.features.split(',');
  if (!names.length && options['affected-only']) throw new Error('Empty feature selection');
  const inputPath = resolve(options.inputs ?? '.test-artifacts/harness/1.0.0/inputs.json');
  const output = resolve(options.output ?? join(dirname(inputPath), 'feature-runs', Date.now().toString()));
  const reportPath = join(output, 'report.json'), progressPath = join(output, 'progress.jsonl');
  const startedAt = new Date().toISOString();
  const report = { schema: 1, purpose: options['affected-only'] ? 'affected-only' : 'feature-completion', features: [...new Set(names)].sort(),
    selected: { node: [], cli: [] }, requirements: [], status: 'setup-failed', phase: 'setup', currentStage: null, stages: [], startedAt, elapsedMs: null,
    progress: basename(progressPath) };
  mkdirSync(output, { recursive: true }); resetProgressFile(progressPath);
  appendProgress(progressPath, { event: 'feature-started', at: startedAt }); writeReport(reportPath, report);
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
    report.phase = 'execution';
    for (const stage of stages) {
      const begin = performance.now(), stageStartedAt = new Date().toISOString(), file = join(output, stage.name + '.json');
      const stageReport = { name: stage.name, report: basename(file), progress: { events: `${stage.name}.progress.jsonl`, tests: `${stage.name}.tests.jsonl` },
        startedAt: stageStartedAt, elapsedMs: null, status: 'running' };
      report.stages.push(stageReport); report.currentStage = stage.name; report.status = 'running';
      appendProgress(progressPath, { event: 'stage-started', stage: stage.name, at: stageStartedAt }); writeReport(reportPath, report);
      let result;
      try {
        result = await run({ inputs: inputPath, suite: stage.suite, files: stage.files, 'network-isolated': options['network-isolated'], output: file });
      } catch (error) {
        const child = classifiedChildFailure(file);
        stageReport.status = child?.status ?? 'harness-failed'; stageReport.reason = child?.reason ?? 'runner-exception';
        stageReport.counts = child?.counts; stageReport.selected = child?.selected;
        stageReport.elapsedMs = performance.now() - begin;
        stageReport.finishedAt = new Date().toISOString(); report.status = stageReport.status; report.reason = stageReport.reason; report.currentStage = null;
        appendProgress(progressPath, { event: 'stage-complete', stage: stage.name, status: stageReport.status, reason: stageReport.reason, elapsedMs: stageReport.elapsedMs, at: stageReport.finishedAt });
        writeReport(reportPath, report);
        throw error;
      }
      stageReport.elapsedMs = performance.now() - begin; stageReport.finishedAt = new Date().toISOString();
      stageReport.status = result.status; stageReport.counts = result.counts; stageReport.selected = result.selected;
      report.currentStage = null;
      if (result.status !== 'passed' || (result.counts?.skipped ?? 0) > 0 || (result.counts?.todo ?? 0) > 0) {
        report.status = result.status === 'passed' ? 'incomplete' : result.status;
      }
      appendProgress(progressPath, { event: 'stage-complete', stage: stage.name, status: stageReport.status, elapsedMs: stageReport.elapsedMs,
        counts: stageReport.counts ?? null, at: stageReport.finishedAt });
      writeReport(reportPath, report);
      if (report.status !== 'running') return report;
    }
    report.status = 'passed'; return report;
  } catch (error) {
    if (report.phase === 'setup') report.reason = 'setup-failed';
    throw error;
  } finally {
    report.elapsedMs = performance.now() - started;
    report.totalWithRecordedPreparationMs = report.elapsedMs + (!options.refresh ? report.preparation?.elapsedMs ?? 0 : 0);
    report.finishedAt = new Date().toISOString(); report.phase = 'complete'; report.currentStage = null;
    appendProgress(progressPath, { event: 'feature-complete', status: report.status, elapsedMs: report.elapsedMs, at: report.finishedAt });
    writeReport(reportPath, report);
    console.log(`Feature stages: ${report.stages.map(stage => `${stage.name}=${(stage.elapsedMs / 1000).toFixed(1)}s`).join(', ')}`);
    console.log('Feature report: ' + reportPath);
    console.log('Feature progress: ' + progressPath);
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({ options: {
    inputs: { type: 'string' }, features: { type: 'string' }, output: { type: 'string' }, refresh: { type: 'boolean' },
    'affected-only': { type: 'boolean' }, 'check-types': { type: 'boolean' }, 'network-isolated': { type: 'boolean' },
  } });
  const result = await runFeature(values); if (result.status !== 'passed') process.exitCode = 1;
}

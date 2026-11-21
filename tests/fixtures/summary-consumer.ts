import assert from 'node:assert/strict';
import { RenderCache } from '../../src/render-cache.ts';
import { toolFields } from '../../src/host/pi/tool-components.ts';
import { ToolProducerPresenter } from '../../src/presentation/tool-producers.ts';
import { ToolPresentationSessions } from '../../src/presentation/tool-sessions.ts';
import { ToolPresentationPolicy } from '../../src/presentation/tool-policy.ts';
import { ToolRoutingPresenter } from '../../src/presentation/tool-routing-presenter.ts';
import { ToolSummaryPresenter } from '../../src/presentation/tool-summary-presenter.ts';
import { createToolPreparationPresenter } from '../../src/presentation/tool-preparation.ts';
import { PreparedLayoutPresenter } from '../../src/presentation/prepared-layout-presenter.ts';
import { FileDetailPresenter } from '../../src/presentation/file-detail-presenter.ts';
import { createToolViewPresenter } from '../../src/presentation/tool-view-presenter.ts';
import { PresentationSpinner } from '../../src/presentation/spinner.ts';
import { Tool, color } from './sdk-contract-support.ts';

/** Real presentation collaborators with one attached compact tool and no source/card service. */
export function summaryConsumer(tool: Tool, Summary = ToolSummaryPresenter) {
  const unexpected = (): never => assert.fail('compact-summary control reached a card/source/native-body path');
  const noop = () => {};
  let active = true;
  const cache = new RenderCache(), producer = new ToolProducerPresenter(toolFields);
  const sessions = new ToolPresentationSessions({ args: toolFields.args, result: toolFields.result,
    funding: () => undefined, failed: unexpected });
  const facts = { active: () => active, name: toolFields.name, toolCallId: toolFields.id, expanded: toolFields.expanded,
    hidden: () => false, attached: (owner: object) => active && owner === tool };
  const policy = new ToolPresentationPolicy(producer, sessions, facts, {
    cards: new Set<string>(), compact: new Set<string>(), native: new Set<string>(),
  });
  const routing = new ToolRoutingPresenter(policy, {
    fileRenderer: () => false, readRenderer: () => false, selfShell: () => false,
    deferredFilePair: () => false, stockEditShell: () => false, visible: unexpected,
  });
  const summary = new Summary(producer, sessions.fileDetails, sessions, cache);
  let view: ReturnType<typeof createToolViewPresenter<object, never>>;
  const spinner = new PresentationSpinner({ ...facts, quiescing: () => false,
    executing: (owner: object) => view.executing(owner), requestRender: noop, fields: toolFields });
  const preparation = createToolPreparationPresenter({ fields: toolFields, producer, sessions, policy, routing,
    cards: () => undefined, ensureCards: unexpected,
    facts: { ...facts, workActive: facts.active, quiescing: () => false, cwd: () => '/project', live: () => false },
    palette: { needsInput: () => false, input: unexpected, mode: () => 'truecolor', generation: unexpected },
    displayBasis: unexpected, invalidate: unexpected, forget: (owner, cause) => view.forget(owner, cause),
    refreshTarget: unexpected, requestRender: noop, flush: unexpected,
  });
  const prepared = new PreparedLayoutPresenter({ sessions, ordinaryCache: cache, cardCache: cache, producer,
    active: facts.active, outputPadding: () => 1, funding: () => undefined, visit: unexpected, identities: unexpected,
    fileMode: owner => policy.fileMode(owner), unsupportedFullFile: preparation.unsupportedFullFile,
    refuse: unexpected, observePalette: unexpected, displayBasis: unexpected, piDisplay: unexpected, decision: unexpected });
  const detail = new FileDetailPresenter({ sessions, cache, producer, details: sessions.fileDetails, summaries: summary,
    theme: () => color, padding: () => 1, mode: owner => policy.fileMode(owner), cwd: () => '/project',
    unsupported: unexpected, serviceRows: unexpected });
  view = createToolViewPresenter({ fields: toolFields, producer, sessions, policy, routing, preparation, summary, detail, prepared,
    cards: () => undefined, funding: () => undefined, theme: () => color, padding: () => 1, paletteOrigin: () => 'pi',
    decision: noop, invalidated: noop, phase: noop,
    host: { ...facts, quiescing: () => false, cwd: () => '/project',
      isTool: (owner): owner is object => owner === tool, siblings: () => [tool], index: () => 0,
      otherRows: unexpected, nativeRows: unexpected, imageRows: unexpected,
      releaseFileRenderer: noop, syncRendererArgs: noop, selection: () => false,
      setExpanded: (_owner, value) => tool.setExpanded(value), requestRender: noop },
    animation: { animate: owner => spinner.animate(owner), remove: owner => spinner.remove(owner),
      time: () => spinner.time(), epoch: () => spinner.epoch() },
  });
  return {
    render(width: number) {
      spinner.beginPass();
      try { return view.render(tool, width, unexpected); }
      finally { spinner.endPass(true); }
    },
    updateResult(result: Tool['result'], partial = false) {
      view.update(tool, 'updateResult', [result, partial], () => tool.updateResult(result, partial));
    },
    dispose() {
      view.remove(tool); active = false; spinner.reset(); cache.clear();
      assert.equal(cache.stats().retainedBytes, 0);
      assert.equal(spinner.snapshot().participants, 0);
      assert.equal(spinner.snapshot().timer, false);
    },
  };
}

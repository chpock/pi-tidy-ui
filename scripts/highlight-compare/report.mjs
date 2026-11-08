const colorText = color => color.mode === 'rgb' ? '#' + color.value.toString(16).padStart(6, '0')
  : color.mode === 'indexed' ? `index:${color.value}` : 'terminal-default';
const quoted = text => JSON.stringify(text).replaceAll('|', '\\|');

function profileText(colors) {
  const runs = [];
  for (const color of colors) {
    const text = colorText(color), prior = runs.at(-1);
    if (prior?.text === text) prior.count++;
    else runs.push({ text, count: 1 });
  }
  return runs.map(run => run.text + (run.count > 1 ? ` ×${run.count}` : '')).join('; ');
}

export function renderDiffReport(report) {
  const lines = ['# TUI structural diff comparison', '',
    `${report.fixture.id}: ${report.theme.family} / ${report.theme.variant}; ${report.viewIdentity}.`, '',
    `${report.rowsCompared} logical row/side observations compared; ${report.differences.length} different structural channels.`, '',
    'These emitted colors are observations, not quality scores. Syntax foregrounds and fonts inside diff bodies are not compared. RGB, indexed and terminal-default colors remain distinct.', '',
    `Card background: left ${profileText(report.cardBackground.left)}; right ${profileText(report.cardBackground.right)}.`, '',
    '| Side / row / old → new | Role / source | Channel | Left | Right |',
    '|---|---|---|---|---|'];
  for (const role of report.roles) for (const [channel, values] of Object.entries(role.channels)) {
    lines.push(`| ${role.side} / ${role.logicalRow} / ${role.oldLine ?? '—'} → ${role.newLine ?? '—'} | ${role.role} ${quoted(role.text)} | ${channel} | ${profileText(values.left)} | ${profileText(values.right)} |`);
  }
  if (report.alignmentPadding.length) {
    lines.push('', '## Empty split-side alignment', '', '| Side / aligned logical row | Channel | Left | Right |', '|---|---|---|---|');
    for (const item of report.alignmentPadding) for (const channel of ['gutterBackground', 'contentBackground']) {
      const values = item[channel];
      lines.push(`| ${item.side} / ${item.alignedRow} | ${channel} | ${profileText(values.left)} | ${profileText(values.right)} |`);
    }
  }
  const geometry = report.geometryDifferences;
  lines.push('', '## Geometry', '',
    `${geometry.sourceProjectionDifferences.length} source projection-width differences retained separately.`,
    `Tab projection: left ${geometry.leftTab.mode}/${geometry.leftTab.size}; right ${geometry.rightTab.mode}/${geometry.rightTab.size}.`,
    'The JSON report retains complete physical pane, screen, surface and source geometry independently of color equality.');
  return lines.join('\n') + '\n';
}

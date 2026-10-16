import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export function collectConsumerDiagnostics(preparation) {
  if (!isAbsolute(preparation)) throw new Error('Consumer preparation path must be absolute');
  const retain = reports => {
    if (!existsSync(reports)) return;
    for (const directory of readdirSync(reports, { withFileTypes: true })) {
      if (!directory.isDirectory() || !/^installed-preparation-[\w-]+$/.test(directory.name)) continue;
      for (const file of ['fixture.json', 'npm.json']) {
        const source = join(reports, directory.name, file);
        if (!existsSync(source)) continue;
        const output = join(preparation, 'diagnostics', directory.name);
        mkdirSync(output, { recursive: true });
        copyFileSync(source, join(output, file));
      }
    }
  };
  retain(join(preparation, 'consumer', 'diagnostics'));
  const receipt = join(preparation, 'inputs.json');
  if (!existsSync(receipt)) return;
  const inputs = JSON.parse(readFileSync(receipt, 'utf8'));
  if (!inputs.source || typeof inputs.source.root !== 'string' || !isAbsolute(inputs.source.root)) throw new Error('Consumer source root must be absolute');
  retain(join(inputs.source.root, '.test-artifacts'));
}

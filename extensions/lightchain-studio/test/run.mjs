// Bundles test/*.test.ts with esbuild (vscode → test/vscode-mock.js) and runs them with node:test.
import { createRequire } from 'node:module';
import { readdirSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, '..');
// esbuild lives in tools/ (repo) or next to the sources (fork-tools)
const nodeModules = [join(ext, 'tools', 'node_modules'), join(ext, 'node_modules')];
const require = createRequire(join(nodeModules.find(p => { try { createRequire(join(p, 'x')).resolve('esbuild'); return true; } catch { return false; } }) ?? nodeModules[0], 'x'));
const { build } = require('esbuild');

const out = join(here, '.out');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// The extension bundle itself (esbuild is stricter than tsc in places, e.g. mixing ?? and &&).
try {
	await build({ entryPoints: [join(ext, 'src', 'extension.ts')], outfile: join(out, 'extension.bundle.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], nodePaths: nodeModules, logLevel: 'error' });
	console.log('✔ extension bundles');
} catch {
	console.error('✖ extension does not bundle');
	process.exit(1);
}
const tests = readdirSync(here).filter(f => f.endsWith('.test.ts'));
for (const t of tests) {
	await build({
		entryPoints: [join(here, t)], outfile: join(out, t.replace(/\.ts$/, '.cjs')),
		bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'error',
		alias: { vscode: join(here, 'vscode-mock.js') }, nodePaths: nodeModules,
	});
}
const r = spawnSync(process.execPath, ['--test', ...tests.map(t => join(out, t.replace(/\.ts$/, '.cjs')))], { stdio: 'inherit' });
process.exit(r.status ?? 1);

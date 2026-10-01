// Bundles the Lightchain Studio extension (src/) into dist/extension.js.
// Run from this folder: npm install && npm run build
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

await build({
	entryPoints: [join(here, 'src', 'extension.ts')],
	outfile: join(here, 'dist', 'extension.js'),
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	external: ['vscode'],
	minify: true,
	sourcemap: false,
	legalComments: 'none',
});
console.log('built dist/extension.js');

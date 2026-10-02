// Bundles the Lightchain Studio extension (../src) into ../dist/extension.js.
// Run from this folder: npm install && npm run build
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tools = dirname(fileURLToPath(import.meta.url));
const ext = join(tools, '..');

await build({
	entryPoints: [join(ext, 'src', 'extension.ts')],
	outfile: join(ext, 'dist', 'extension.js'),
	nodePaths: [join(tools, 'node_modules')],
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

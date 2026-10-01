import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';

export interface ToolCall { name: string; args: Record<string, any> }
export interface ToolResult { ok: boolean; output: string }

export interface ApprovalRequest {
	kind: 'write' | 'edit' | 'command';
	title: string;        // e.g. "Create src/Token.sol"
	detail?: string;      // command line, etc.
	diff?: { path: string; before: string; after: string };
}

export interface ToolContext {
	root: string;                                        // workspace root (absolute)
	approve(req: ApprovalRequest): Promise<boolean>;     // UI approval gate
	forgePath?: string;
}

export interface Tool {
	name: string;
	description: string;
	args: string;
	run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult>;
}

const MAX_READ = 60_000;
const MAX_OUTPUT = 12_000;
const IGNORE = new Set(['node_modules', '.git', 'out', 'cache', 'lib', 'broadcast', 'artifacts', 'dist']);

/** Resolve `rel` inside the project; refuse anything that escapes it (incl. via symlinks). */
async function safePath(ctx: ToolContext, rel: unknown): Promise<string> {
	if (typeof rel !== 'string' || !rel.trim()) {
		throw new Error('A relative "path" is required.');
	}
	const abs = path.resolve(ctx.root, rel);
	const rootReal = await fs.realpath(ctx.root);
	if (abs !== ctx.root && !abs.startsWith(ctx.root + path.sep)) {
		throw new Error(`Path "${rel}" is outside the project.`);
	}
	// If the path (or its nearest existing parent) is a symlink, check where it really points.
	let probe = abs;
	while (true) {
		try {
			const real = await fs.realpath(probe);
			if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
				throw new Error(`Path "${rel}" resolves outside the project.`);
			}
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw err;
			}
			const parent = path.dirname(probe);
			if (parent === probe) {
				break;
			}
			probe = parent;
		}
	}
	return abs;
}

const rel = (ctx: ToolContext, abs: string) => path.relative(ctx.root, abs) || '.';
const clip = (s: string, n = MAX_OUTPUT) => s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters truncated)` : s;

export const TOOLS: Tool[] = [
	{
		name: 'list_dir',
		description: 'List files and folders (recursive, skips node_modules/.git/out/cache/lib/broadcast).',
		args: '{"path": "." , "depth"?: 3}',
		async run(args, ctx) {
			const start = await safePath(ctx, args.path ?? '.');
			const depth = Math.min(Number(args.depth ?? 3), 6);
			const lines: string[] = [];
			const walk = async (dir: string, d: number) => {
				if (lines.length > 400) {
					return;
				}
				const entries = await fs.readdir(dir, { withFileTypes: true });
				for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
					if (IGNORE.has(e.name) || e.name.startsWith('.')) {
						continue;
					}
					const p = path.join(dir, e.name);
					lines.push(`${'  '.repeat(depth - d)}${rel(ctx, p)}${e.isDirectory() ? '/' : ''}`);
					if (e.isDirectory() && d > 1) {
						await walk(p, d - 1);
					}
				}
			};
			await walk(start, depth);
			return { ok: true, output: lines.join('\n') || '(empty)' };
		},
	},
	{
		name: 'read_file',
		description: 'Read a text file.',
		args: '{"path": "src/Counter.sol"}',
		async run(args, ctx) {
			const p = await safePath(ctx, args.path);
			const text = await fs.readFile(p, 'utf8');
			return { ok: true, output: clip(text, MAX_READ) };
		},
	},
	{
		name: 'search',
		description: 'Search project files for a text (case-insensitive). Returns file:line: text.',
		args: '{"query": "Counter"}',
		async run(args, ctx) {
			const q = String(args.query ?? '').toLowerCase();
			if (!q) {
				return { ok: false, output: 'A "query" is required.' };
			}
			const files = await vscode.workspace.findFiles(new vscode.RelativePattern(ctx.root, '**/*'), '{**/node_modules/**,**/.git/**,**/out/**,**/cache/**,**/lib/**,**/broadcast/**}', 2000);
			const hits: string[] = [];
			for (const f of files) {
				if (hits.length >= 100) {
					break;
				}
				try {
					const lines = (await fs.readFile(f.fsPath, 'utf8')).split('\n');
					lines.forEach((l, i) => { if (hits.length < 100 && l.toLowerCase().includes(q)) { hits.push(`${rel(ctx, f.fsPath)}:${i + 1}: ${l.trim().slice(0, 200)}`); } });
				} catch { /* binary/unreadable */ }
			}
			return { ok: true, output: hits.join('\n') || 'No matches.' };
		},
	},
	{
		name: 'write_file',
		description: 'Create or overwrite a file with the full content (needs user approval).',
		args: '{"path": "src/Token.sol", "content": "// full file content"}',
		async run(args, ctx) {
			const p = await safePath(ctx, args.path);
			if (typeof args.content !== 'string') {
				return { ok: false, output: '"content" (string) is required.' };
			}
			const before = await fs.readFile(p, 'utf8').catch(() => '');
			const ok = await ctx.approve({ kind: 'write', title: `${before ? 'Overwrite' : 'Create'} ${rel(ctx, p)}`, diff: { path: rel(ctx, p), before, after: args.content } });
			if (!ok) {
				return { ok: false, output: 'The user rejected this change.' };
			}
			await fs.mkdir(path.dirname(p), { recursive: true });
			await fs.writeFile(p, args.content, 'utf8');
			return { ok: true, output: `Wrote ${rel(ctx, p)} (${args.content.split('\n').length} lines).` };
		},
	},
	{
		name: 'edit_file',
		description: 'Replace an exact snippet in a file (needs user approval). "old" must match the file exactly once.',
		args: '{"path": "src/Counter.sol", "old": "exact existing text", "new": "replacement text"}',
		async run(args, ctx) {
			const p = await safePath(ctx, args.path);
			const before = await fs.readFile(p, 'utf8');
			const old = String(args.old ?? '');
			const count = old ? before.split(old).length - 1 : 0;
			if (count !== 1) {
				return { ok: false, output: count === 0 ? '"old" text not found — read the file and copy the exact text.' : `"old" text matches ${count} times — include more context so it is unique.` };
			}
			const after = before.replace(old, String(args.new ?? ''));
			const ok = await ctx.approve({ kind: 'edit', title: `Edit ${rel(ctx, p)}`, diff: { path: rel(ctx, p), before, after } });
			if (!ok) {
				return { ok: false, output: 'The user rejected this change.' };
			}
			await fs.writeFile(p, after, 'utf8');
			return { ok: true, output: `Edited ${rel(ctx, p)}.` };
		},
	},
	{
		name: 'forge_build',
		description: 'Compile the project with Foundry (forge build). Returns compiler output.',
		args: '{}',
		async run(_args, ctx) {
			if (!ctx.forgePath) {
				return { ok: false, output: 'Foundry (forge) is not installed.' };
			}
			return runProcess(ctx.forgePath, ['build'], ctx.root);
		},
	},
	{
		name: 'run_command',
		description: 'Run a shell command in the project root, e.g. "forge test" (needs user approval). Returns output.',
		args: '{"command": "forge test -vv"}',
		async run(args, ctx) {
			const command = String(args.command ?? '').trim();
			if (!command) {
				return { ok: false, output: 'A "command" is required.' };
			}
			const ok = await ctx.approve({ kind: 'command', title: 'Run command', detail: command });
			if (!ok) {
				return { ok: false, output: 'The user rejected this command.' };
			}
			const shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/sh');
			const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
			return runProcess(shell, shellArgs, ctx.root);
		},
	},
];

function runProcess(cmd: string, args: string[], cwd: string): Promise<ToolResult> {
	return new Promise(resolve => {
		const env = { ...process.env, PATH: `${process.env.HOME}/.foundry/bin${path.delimiter}${process.env.PATH ?? ''}` };
		execFile(cmd, args, { cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
			const out = clip(`${stdout}${stderr ? `\n${stderr}` : ''}`.trim());
			resolve({ ok: !err, output: out || (err ? err.message : '(no output)') });
		});
	});
}

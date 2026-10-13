import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';

export interface ToolCall { name: string; args: Record<string, any> }
export interface ToolResult { ok: boolean; output: string }

/**
 * Replies are capped in length, so a model rewriting a long file often sends a stub or
 * stops halfway. Catch a rewrite that drops most of an existing file before it is shown.
 */
export function truncatedRewrite(before: string, after: string): string | undefined {
	const count = (t: string) => t.split('\n').filter(l => l.trim()).length;
	const was = count(before), now = count(after);
	if (was < 15 || now >= was * 0.4) {
		return undefined;
	}
	return `Not written: the new content has ${now} lines but the file has ${was}, so most of it would be lost (your reply was probably cut off). Send the COMPLETE file, or, if the file is long, change it in smaller parts: write only what changes and keep every other line exactly as it is.`;
}

export interface ApprovalRequest {
	kind: 'write' | 'edit' | 'command';
	title: string;        // e.g. "Create src/Token.sol"
	detail?: string;      // command line, etc.
	diff?: { path: string; before: string; after: string };
}

/** The user kept only some of the changes: write `content` instead, tell the model `note`. */
export interface PartialApproval { content: string; note: string }

export interface ToolContext {
	root: string;                                        // workspace root (absolute)
	/** UI approval gate: true/false, or the user's partial acceptance of a file change. */
	approve(req: ApprovalRequest): Promise<boolean | PartialApproval>;
	forgePath?: string;
	/** Called after a file write; `before` is undefined when the file did not exist (for checkpoints). */
	onWrite?(absPath: string, before: string | undefined, after: string): void;
}

export interface Tool {
	name: string;
	description: string;
	args: string;
	run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult>;
}

const MAX_READ = 20_000; // the model's window is small; longer files are clipped with a note
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
			const existing = await fs.readFile(p, 'utf8').catch(() => undefined);
			const before = existing ?? '';
			if (existing !== undefined && existing === args.content) {
				// a model stuck on an error tends to write the same file again: tell it, instead of asking the user to approve nothing
				return { ok: false, output: `No change: ${rel(ctx, p)} already has exactly this content. If a build or test still fails, read the error again and change the lines it points at.` };
			}
			const shrink = truncatedRewrite(before, args.content);
			if (shrink) {
				return { ok: false, output: shrink };
			}
			const decision = await ctx.approve({ kind: 'write', title: `${before ? 'Overwrite' : 'Create'} ${rel(ctx, p)}`, diff: { path: rel(ctx, p), before, after: args.content } });
			if (!decision) {
				return { ok: false, output: 'The user rejected this change.' };
			}
			const content = typeof decision === 'object' ? decision.content : args.content;
			await fs.mkdir(path.dirname(p), { recursive: true });
			await fs.writeFile(p, content, 'utf8');
			ctx.onWrite?.(p, existing, content);
			if (typeof decision === 'object') {
				return { ok: true, output: `Wrote ${rel(ctx, p)}. ${decision.note}` };
			}
			return { ok: true, output: `Wrote ${rel(ctx, p)} (${args.content.split('\n').length} lines).` };
		},
	},
	{
		name: 'append_file',
		description: 'Add text to the end of a file written earlier in this task (needs user approval). For files too long for one reply: write_file the first part, then append_file the rest, part by part.',
		args: '{"path": "src/Token.sol", "content": "// the next part of the file"}',
		async run(args, ctx) {
			const p = await safePath(ctx, args.path);
			if (typeof args.content !== 'string' || !args.content) {
				return { ok: false, output: '"content" (string) is required.' };
			}
			const before = await fs.readFile(p, 'utf8').catch(() => undefined);
			if (before === undefined) {
				return { ok: false, output: `${rel(ctx, p)} does not exist yet. Start it with write_file, then append_file the rest.` };
			}
			// the same part sent twice (a retried reply) must not be added twice
			if (args.content.trim().length > 40 && before.trimEnd().endsWith(args.content.trim())) {
				return { ok: false, output: `No change: ${rel(ctx, p)} already ends with exactly this part. Send the NEXT part, or stop if the file is complete.` };
			}
			const after = before + (before.endsWith('\n') || args.content.startsWith('\n') ? '' : '\n') + args.content + (args.content.endsWith('\n') ? '' : '\n');
			const decision = await ctx.approve({ kind: 'write', title: `Add to ${rel(ctx, p)}`, diff: { path: rel(ctx, p), before, after } });
			if (!decision) {
				return { ok: false, output: 'The user rejected this change.' };
			}
			const content = typeof decision === 'object' ? decision.content : after;
			await fs.writeFile(p, content, 'utf8');
			ctx.onWrite?.(p, before, content);
			return { ok: true, output: `Wrote ${rel(ctx, p)} (now ${content.split('\n').length} lines).` };
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
			const replacement = String(args.new ?? '');
			const count = old ? before.split(old).length - 1 : 0;
			let after: string | undefined;
			if (count === 1) {
				after = before.replace(old, replacement);
			} else if (count > 1) {
				return { ok: false, output: `"old" text matches ${count} times — include more surrounding lines so it is unique.` };
			} else {
				// Small models rarely copy indentation/spacing exactly: match line by line ignoring whitespace.
				after = looseReplace(before, old, replacement);
				if (after === undefined) {
					return { ok: false, output: `"old" text not found in ${rel(ctx, p)}. Copy it exactly from the current file below, or use write_file with the complete new content.\n\n${numbered(before)}` };
				}
			}
			const ok = !!(await ctx.approve({ kind: 'edit', title: `Edit ${rel(ctx, p)}`, diff: { path: rel(ctx, p), before, after } }));
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
		name: 'forge_test',
		description: 'Run the Foundry tests (forge test). Optional "match": a test contract or test function name to run only those. Returns the result summary.',
		args: '{"match": "CounterTest"}',
		async run(args, ctx) {
			if (!ctx.forgePath) {
				return { ok: false, output: 'Foundry (forge) is not installed.' };
			}
			const match = typeof args.match === 'string' && /^[\w.*-]+$/.test(args.match) ? args.match : undefined;
			const filter = match ? [/^[a-z]/.test(match) ? '--match-test' : '--match-contract', match] : [];
			return runProcess(ctx.forgePath, ['test', '-vv', ...filter], ctx.root, true);
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
			const ok = !!(await ctx.approve({ kind: 'command', title: 'Run command', detail: command }));
			if (!ok) {
				return { ok: false, output: 'The user rejected this command.' };
			}
			const shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/sh');
			const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
			return runProcess(shell, shellArgs, ctx.root);
		},
	},
];

/** Runs a process; `tail` keeps the end of long output (where test summaries are). */
function runProcess(cmd: string, args: string[], cwd: string, tail = false): Promise<ToolResult> {
	return new Promise(resolve => {
		const env = { ...process.env, PATH: `${process.env.HOME}/.foundry/bin${path.delimiter}${process.env.PATH ?? ''}` };
		execFile(cmd, args, { cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
			const all = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim();
			const out = tail && all.length > MAX_OUTPUT ? `… (${all.length - MAX_OUTPUT} earlier characters omitted)\n${all.slice(-MAX_OUTPUT)}` : clip(all);
			resolve({ ok: !err, output: out || (err ? err.message : '(no output)') });
		});
	});
}

/** Whitespace-insensitive, line-based replace of `old` by `replacement`; undefined unless exactly one match. */
export function looseReplace(text: string, old: string, replacement: string): string | undefined {
	const norm = (l: string) => l.replace(/\s+/g, ''); // spacing/indentation never decide a match
	const lines = text.split('\n');
	const want = old.split('\n').map(norm);
	while (want.length && !want[0]) { want.shift(); }
	while (want.length && !want[want.length - 1]) { want.pop(); }
	if (!want.length) {
		return undefined;
	}
	const hits: number[] = [];
	for (let i = 0; i + want.length <= lines.length; i++) {
		if (want.every((w, k) => norm(lines[i + k]) === w)) {
			hits.push(i);
		}
	}
	if (hits.length !== 1) {
		return undefined;
	}
	const start = hits[0];
	// keep the file's indentation when the replacement comes without any
	const indentOf = (k: number) => /^\s*/.exec(lines[start + Math.min(k, want.length - 1)])![0];
	const repl = replacement.replace(/\n$/, '').split('\n');
	const hasIndent = repl.some(l => /^\s+\S/.test(l));
	// line k of the replacement takes the indentation of the line it replaces
	const placed = hasIndent ? repl : repl.map((l, k) => (l.trim() ? indentOf(k) + l.trim() : l));
	return [...lines.slice(0, start), ...placed, ...lines.slice(start + want.length)].join('\n');
}

/** File content with line numbers, capped, for an error the model can copy from. */
function numbered(text: string): string {
	const out = text.split('\n').map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join('\n');
	return out.length > 6000 ? out.slice(0, 6000) + '\n… (truncated)' : out;
}

import * as vscode from 'vscode';
import { formatFrontMatter, parseFrontMatter, slug, uniqueSlug } from './markdown';

/**
 * Project instructions for Lightchain AI: Markdown files the whole team shares
 * through git. One file per instruction in .lightchain/rules/, with front
 * matter saying when it applies:
 *
 *   always   every conversation
 *   files    when a file matching one of its globs is in the prompt's context
 *   manual   only when the user @-mentions it
 *
 * .lightchain/rules.md and a root AGENTS.md are read too (always applied), so
 * projects that already have them work unchanged.
 */
export type RuleApply = 'always' | 'files' | 'manual';

export interface Rule {
	id: string;
	title: string;
	description: string;
	apply: RuleApply;
	globs: string[];
	body: string;
	/** Workspace-relative path of the file it lives in. */
	file: string;
	/** Single-file sources (rules.md, AGENTS.md) can be edited as Markdown but not re-scoped. */
	fixed?: boolean;
}

export const RULES_DIR = '.lightchain/rules';
/** Characters of instructions sent with a conversation; the model's window is small. */
export const RULES_BUDGET = 2_400;

export function parseRule(id: string, text: string, file: string): Rule {
	const { data, body } = parseFrontMatter(text);
	const str = (k: string) => typeof data[k] === 'string' ? (data[k] as string).trim() : '';
	const globs = (Array.isArray(data.globs) ? data.globs : str('globs') ? str('globs').split(',') : []).map(g => g.trim()).filter(Boolean).slice(0, 12);
	const explicit = str('apply').toLowerCase();
	// Cursor's own fields are understood too: alwaysApply + globs
	const apply: RuleApply = explicit === 'always' || explicit === 'files' || explicit === 'manual' ? explicit
		: data.alwaysApply === true ? 'always'
			: globs.length ? 'files'
				: data.alwaysApply === false ? 'manual' : 'always';
	const heading = /^#\s+(.+)$/m.exec(body)?.[1].trim();
	return {
		id, file,
		title: (str('title') || str('name') || heading || id.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase())).slice(0, 60),
		description: str('description').slice(0, 160),
		apply,
		globs,
		body,
	};
}

export function ruleToMarkdown(r: Pick<Rule, 'title' | 'description' | 'apply' | 'globs' | 'body'>): string {
	return formatFrontMatter({
		title: r.title,
		description: r.description || undefined,
		apply: r.apply,
		globs: r.apply === 'files' ? r.globs : undefined,
	}, r.body);
}

/** `src/**\/*.sol`, `*.t.sol`, `test/` → a RegExp over workspace-relative paths. */
export function globToRegExp(glob: string): RegExp {
	let g = glob.trim().replace(/^\.\//, '');
	if (g.endsWith('/')) {
		g += '**';
	}
	const anywhere = !g.includes('/'); // "*.sol" matches in any folder, like .gitignore
	let re = '';
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === '*') {
			if (g[i + 1] === '*') {
				i++;
				if (g[i + 1] === '/') {
					i++;
					re += '(?:.*/)?';
				} else {
					re += '.*';
				}
			} else {
				re += '[^/]*';
			}
		} else if (c === '?') {
			re += '[^/]';
		} else if (c === '{') {
			const end = g.indexOf('}', i);
			if (end > i) {
				re += `(?:${g.slice(i + 1, end).split(',').map(x => x.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
				i = end;
			} else {
				re += '\\{';
			}
		} else {
			re += c.replace(/[.+^$()|[\]\\}]/g, '\\$&');
		}
	}
	return new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${re}$`);
}

export function ruleMatches(rule: Rule, files: string[]): boolean {
	if (rule.apply !== 'files') {
		return false;
	}
	const tests = rule.globs.map(globToRegExp);
	return files.some(f => tests.some(t => t.test(f.replace(/\\/g, '/'))));
}

export interface RenderedRules {
	text: string;
	/** Characters each instruction contributes and whether it had to be cut. */
	parts: { id: string; chars: number; cut: boolean }[];
}

/** Instructions as prompt text, cut to `budget` characters (earlier ones first). */
export function renderRules(rules: Rule[], budget = RULES_BUDGET): RenderedRules {
	const parts: RenderedRules['parts'] = [];
	const out: string[] = [];
	let left = budget;
	for (const r of rules) {
		const body = r.body.trim();
		if (!body) {
			continue;
		}
		const head = `[${r.title}]`;
		const room = left - head.length - 1;
		if (room < 80) {
			parts.push({ id: r.id, chars: 0, cut: true });
			continue;
		}
		const cut = body.length > room;
		const text = cut ? body.slice(0, room - 14).trimEnd() + '\n… (cut short)' : body;
		out.push(`${head}\n${text}`);
		parts.push({ id: r.id, chars: text.length + head.length + 1, cut });
		left -= text.length + head.length + 3;
	}
	return { text: out.join('\n\n'), parts };
}

const STARTER = `Write what Lightchain AI should always keep in mind in this project, in plain sentences. For example:

- Use Solidity ^0.8.24 and OpenZeppelin for tokens.
- Every external function needs a test.
- Never use tx.origin for authorisation.
`;

export class RuleStore implements vscode.Disposable {
	private rules: Rule[] = [];
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly disposables: vscode.Disposable[] = [this.changed];
	private writing = false;
	private loading?: Promise<void>;

	constructor() {
		const root = this.root;
		if (root) {
			const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '{AGENTS.md,.lightchainrules,.lightchain/rules.md,.lightchain/rules/*.md}'));
			const reload = () => { if (!this.writing) { void this.load(); } };
			this.disposables.push(w, w.onDidChange(reload), w.onDidCreate(reload), w.onDidDelete(reload));
		}
		void this.load();
	}

	private get root(): vscode.Uri | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri;
	}

	get all(): Rule[] {
		return this.rules;
	}

	get(id: string): Rule | undefined {
		return this.rules.find(r => r.id === id);
	}

	uri(rule: Rule): vscode.Uri | undefined {
		return this.root && vscode.Uri.joinPath(this.root, rule.file);
	}

	ready(): Promise<void> {
		return this.loading ?? Promise.resolve();
	}

	/** Instructions every conversation starts with. */
	always(): Rule[] {
		return this.rules.filter(r => r.apply === 'always');
	}

	/** Instructions that apply to this prompt only: matching files, or @-mentioned. */
	scoped(files: string[], mentioned: string[]): Rule[] {
		return this.rules.filter(r => r.apply !== 'always' && (mentioned.includes(r.id) || ruleMatches(r, files)));
	}

	private load(): Promise<void> {
		return this.loading = this.read().finally(() => this.changed.fire());
	}

	private async read(): Promise<void> {
		const root = this.root;
		if (!root) {
			this.rules = [];
			return;
		}
		const text = async (rel: string) => {
			try {
				return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, rel)));
			} catch {
				return undefined;
			}
		};
		const rules: Rule[] = [];
		for (const [file, id, title] of [['.lightchain/rules.md', 'project-rules', 'Project rules'], ['.lightchainrules', 'lightchainrules', 'Project rules'], ['AGENTS.md', 'agents-md', 'AGENTS.md']] as const) {
			const src = await text(file);
			if (src?.trim()) {
				const r = parseRule(id, src, file);
				rules.push({ ...r, title, apply: 'always', globs: [], fixed: true });
			}
		}
		try {
			const names = (await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, RULES_DIR))).filter(([n, t]) => t !== vscode.FileType.Directory && /\.mdc?$/i.test(n)).map(([n]) => n).sort();
			for (const name of names) {
				const src = await text(`${RULES_DIR}/${name}`);
				if (src !== undefined) {
					rules.push(parseRule(slug(name.replace(/\.mdc?$/i, ''), 'rule'), src, `${RULES_DIR}/${name}`));
				}
			}
		} catch { /* no rules folder */ }
		this.rules = rules;
	}

	private async hold<T>(work: () => Promise<T>): Promise<T> {
		this.writing = true;
		try {
			return await work();
		} finally {
			setTimeout(() => { this.writing = false; }, 300);
		}
	}

	private need(): vscode.Uri {
		const root = this.root;
		if (!root) {
			throw new Error('Open a project to save instructions with it.');
		}
		return root;
	}

	/** A new instruction file, ready to be written. */
	async create(title = 'New instruction'): Promise<Rule> {
		const root = this.need();
		const id = uniqueSlug(title, this.rules.map(r => r.id), 'rule');
		const rule: Rule = { id, title, description: '', apply: 'always', globs: [], body: STARTER, file: `${RULES_DIR}/${id}.md` };
		await this.hold(async () => {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, RULES_DIR));
			await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, rule.file), new TextEncoder().encode(ruleToMarkdown(rule)));
		});
		this.rules = [...this.rules, rule];
		this.changed.fire();
		return rule;
	}

	async put(next: Rule): Promise<void> {
		const root = this.need();
		const i = this.rules.findIndex(r => r.id === next.id);
		if (i < 0) {
			return;
		}
		const cur = this.rules[i];
		const rule: Rule = cur.fixed
			? { ...cur, body: String(next.body ?? '') }
			: { ...cur, title: String(next.title || cur.title).slice(0, 60), description: String(next.description ?? '').slice(0, 160), apply: next.apply === 'files' || next.apply === 'manual' ? next.apply : 'always', globs: (next.globs ?? []).map(g => String(g).trim()).filter(Boolean).slice(0, 12), body: String(next.body ?? '') };
		this.rules = this.rules.map((r, n) => n === i ? rule : r);
		await this.hold(() => Promise.resolve(vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, rule.file), new TextEncoder().encode(rule.fixed ? rule.body.trim() + '\n' : ruleToMarkdown(rule)))));
		this.changed.fire();
	}

	async remove(id: string): Promise<void> {
		const root = this.need();
		const rule = this.get(id);
		if (!rule) {
			return;
		}
		this.rules = this.rules.filter(r => r.id !== id);
		await this.hold(() => Promise.resolve(vscode.workspace.fs.delete(vscode.Uri.joinPath(root, rule.file))).catch(() => undefined));
		this.changed.fire();
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}

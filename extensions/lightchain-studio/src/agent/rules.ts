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
	/** With the project (shared through git) or with the wallet (personal, in all its projects). Default: project. */
	scope?: 'project' | 'personal';
}

/** How a wallet's own instruction is shown where a project path would be. */
export const PERSONAL_PREFIX = 'Your wallet · ';

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
	private personalWatch?: vscode.Disposable;
	private writing = false;
	private loading?: Promise<void>;

	/**
	 * `personalDir`: the active wallet's folder for its own instructions (undefined without a wallet);
	 * `onSpaceChange`: fires when another wallet becomes active.
	 */
	constructor(private readonly personalDir: () => vscode.Uri | undefined = () => undefined, onSpaceChange?: vscode.Event<void>) {
		const root = this.root;
		const reload = () => { if (!this.writing) { void this.load(); } };
		if (root) {
			const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '{AGENTS.md,.lightchainrules,.lightchain/rules.md,.lightchain/rules/*.md}'));
			this.disposables.push(w, w.onDidChange(reload), w.onDidCreate(reload), w.onDidDelete(reload));
		}
		const watchPersonal = () => {
			this.personalWatch?.dispose();
			const dir = this.personalFolder;
			if (dir) {
				const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '*.md'));
				this.personalWatch = vscode.Disposable.from(w, w.onDidChange(reload), w.onDidCreate(reload), w.onDidDelete(reload));
			}
		};
		watchPersonal();
		if (onSpaceChange) {
			this.disposables.push(onSpaceChange(() => { watchPersonal(); void this.load(); }));
		}
		void this.load();
	}

	private get root(): vscode.Uri | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri;
	}

	private get personalFolder(): vscode.Uri | undefined {
		const dir = this.personalDir();
		return dir && vscode.Uri.joinPath(dir, 'rules');
	}

	/** Which places an instruction can be saved to right now. */
	get scopes(): ('project' | 'personal')[] {
		return [...(this.root ? ['project' as const] : []), ...(this.personalFolder ? ['personal' as const] : [])];
	}

	get all(): Rule[] {
		return this.rules;
	}

	get(id: string): Rule | undefined {
		return this.rules.find(r => r.id === id);
	}

	uri(rule: Rule): vscode.Uri | undefined {
		if (rule.scope === 'personal') {
			return this.personalFolder && vscode.Uri.joinPath(this.personalFolder, `${rule.id}.md`);
		}
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
		const decode = async (uri: vscode.Uri) => {
			try {
				return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
			} catch {
				return undefined;
			}
		};
		const folder = async (dir: vscode.Uri | undefined, make: (id: string, src: string, name: string) => Rule): Promise<Rule[]> => {
			const out: Rule[] = [];
			if (!dir) {
				return out;
			}
			try {
				const names = (await vscode.workspace.fs.readDirectory(dir)).filter(([n, t]) => t !== vscode.FileType.Directory && /\.mdc?$/i.test(n)).map(([n]) => n).sort();
				for (const name of names) {
					const src = await decode(vscode.Uri.joinPath(dir, name));
					if (src !== undefined) {
						out.push(make(slug(name.replace(/\.mdc?$/i, ''), 'rule'), src, name));
					}
				}
			} catch { /* no such folder yet */ }
			return out;
		};
		const rules: Rule[] = [];
		if (root) {
			for (const [file, id, title] of [['.lightchain/rules.md', 'project-rules', 'Project rules'], ['.lightchainrules', 'lightchainrules', 'Project rules'], ['AGENTS.md', 'agents-md', 'AGENTS.md']] as const) {
				const src = await decode(vscode.Uri.joinPath(root, file));
				if (src?.trim()) {
					rules.push({ ...parseRule(id, src, file), title, apply: 'always', globs: [], fixed: true, scope: 'project' });
				}
			}
		}
		// the wallet's own instructions come before the project's, so a tight budget cuts the team's last
		const personal = await folder(this.personalFolder, (id, src, name) => ({ ...parseRule(id, src, `${PERSONAL_PREFIX}${name}`), scope: 'personal' }));
		const project = root ? await folder(vscode.Uri.joinPath(root, RULES_DIR), (id, src, name) => ({ ...parseRule(id, src, `${RULES_DIR}/${name}`), scope: 'project' })) : [];
		const taken = new Set(project.map(r => r.id));
		this.rules = [...rules, ...personal.map(r => taken.has(r.id) ? { ...r, id: `my-${r.id}` } : r), ...project];
	}

	private async hold<T>(work: () => Promise<T>): Promise<T> {
		this.writing = true;
		try {
			return await work();
		} finally {
			setTimeout(() => { this.writing = false; }, 300);
		}
	}

	private fileFor(id: string, scope: 'project' | 'personal'): { uri: vscode.Uri; file: string; dir: vscode.Uri } {
		const dir = scope === 'personal' ? this.personalFolder : this.root && vscode.Uri.joinPath(this.root, RULES_DIR);
		if (!dir) {
			throw new Error(scope === 'personal' ? 'Connect a wallet to keep instructions with it.' : 'Open a project to save instructions with it.');
		}
		return { dir, uri: vscode.Uri.joinPath(dir, `${id}.md`), file: scope === 'personal' ? `${PERSONAL_PREFIX}${id}.md` : `${RULES_DIR}/${id}.md` };
	}

	/** A new instruction file, ready to be written: with the project when one is open, else with the wallet. */
	async create(title = 'New instruction', scope?: 'project' | 'personal'): Promise<Rule> {
		const where = scope ?? this.scopes[0];
		if (!where) {
			throw new Error('Open a project or connect a wallet to save instructions.');
		}
		const id = uniqueSlug(title, this.rules.map(r => r.id), 'rule');
		const at = this.fileFor(id, where);
		const rule: Rule = { id, title, description: '', apply: 'always', globs: [], body: STARTER, file: at.file, scope: where };
		await this.hold(async () => {
			await vscode.workspace.fs.createDirectory(at.dir);
			await vscode.workspace.fs.writeFile(at.uri, new TextEncoder().encode(ruleToMarkdown(rule)));
		});
		this.rules = [...this.rules, rule];
		this.changed.fire();
		return rule;
	}

	/** Saves an instruction; a different `scope` moves it between the project and the wallet. */
	async put(next: Rule): Promise<void> {
		const i = this.rules.findIndex(r => r.id === next.id);
		if (i < 0) {
			return;
		}
		const cur = this.rules[i];
		const from = this.uri(cur);
		if (!from) {
			return;
		}
		const scope = !cur.fixed && (next.scope === 'personal' || next.scope === 'project') && this.scopes.includes(next.scope) ? next.scope : cur.scope ?? 'project';
		const moved = !cur.fixed && scope !== (cur.scope ?? 'project');
		const at = moved ? this.fileFor(cur.id, scope) : undefined;
		const rule: Rule = cur.fixed
			? { ...cur, body: String(next.body ?? '') }
			: { ...cur, title: String(next.title || cur.title).slice(0, 60), description: String(next.description ?? '').slice(0, 160), apply: next.apply === 'files' || next.apply === 'manual' ? next.apply : 'always', globs: (next.globs ?? []).map(g => String(g).trim()).filter(Boolean).slice(0, 12), body: String(next.body ?? ''), scope, file: at?.file ?? cur.file };
		this.rules = this.rules.map((r, n) => n === i ? rule : r);
		await this.hold(async () => {
			if (at) {
				await vscode.workspace.fs.createDirectory(at.dir);
			}
			await vscode.workspace.fs.writeFile(at?.uri ?? from, new TextEncoder().encode(rule.fixed ? rule.body.trim() + '\n' : ruleToMarkdown(rule)));
			if (at) {
				await Promise.resolve(vscode.workspace.fs.delete(from)).catch(() => undefined);
			}
		});
		this.changed.fire();
	}

	async remove(id: string): Promise<void> {
		const rule = this.get(id);
		const uri = rule && this.uri(rule);
		if (!rule || !uri) {
			return;
		}
		this.rules = this.rules.filter(r => r.id !== id);
		await this.hold(() => Promise.resolve(vscode.workspace.fs.delete(uri)).catch(() => undefined));
		this.changed.fire();
	}

	dispose(): void {
		this.personalWatch?.dispose();
		this.disposables.forEach(d => d.dispose());
	}
}

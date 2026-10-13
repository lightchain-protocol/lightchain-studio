import * as vscode from 'vscode';
import { formatFrontMatter, parseFrontMatter, slug, uniqueSlug } from './markdown';

/**
 * Lightchain AI agents people can understand and shape without code: a role in
 * plain words, rules as sentences, switches for what the agent may do and when it
 * must ask. Built-in agents plus the project's own: one Markdown file per agent
 * in .lightchain/agents/ (front matter for the switches, the text is its job),
 * so they can be written by hand, reviewed and shared through git.
 */
export type Approval = 'ask' | 'auto';

export interface AgentProfile {
	id: string;
	name: string;
	color: string;          // card / flow accent
	glyph: string;          // one or two letters shown on the card
	summary: string;        // one line under the name
	role: string;           // what the agent is for, in plain words
	rules: string[];        // plain-sentence rules it always follows
	can: { read: boolean; write: boolean; build: boolean; test: boolean; run: boolean };
	approval: Approval;     // ask before changing files, or apply (undo stays available)
	check: boolean;         // build and test automatically after changing contracts
	model?: string;         // preferred model (empty: the one picked in the chat)
	starters: string[];     // example requests shown in the chat
	builtin?: boolean;
}

export const BUILTIN_AGENTS: AgentProfile[] = [
	{
		id: 'builder', name: 'Contract Builder', color: '#DD00AC', glyph: 'CB', builtin: true,
		summary: 'Writes and changes contracts, builds and tests them',
		role: 'Build what the user asks for: write or change Solidity contracts, their Foundry tests and deploy scripts, then make sure everything compiles and the tests pass.',
		rules: ['Keep contracts simple and readable.', 'Use Solidity ^0.8.24 with an SPDX header.', 'Write a test for every new function.'],
		can: { read: true, write: true, build: true, test: true, run: false }, approval: 'ask', check: true,
		starters: ['Add a fee the owner can withdraw', 'Make a token with a capped supply', 'Add an event when the counter changes'],
	},
	{
		id: 'auditor', name: 'Auditor', color: '#F05252', glyph: 'AU', builtin: true,
		summary: 'Reviews contracts for security problems — changes nothing',
		role: 'Review the code like a security auditor. Find real risks (reentrancy, access control, unchecked calls, bad randomness, overflow, denial of service) and explain each one with its severity, the line and a fix. Never change files.',
		rules: ['Rank findings: critical, high, medium, low.', 'Say clearly when nothing serious is found.', 'Explain fixes in plain words first, code second.'],
		can: { read: true, write: false, build: true, test: false, run: false }, approval: 'ask', check: false,
		starters: ['Audit the contracts in src/', 'Is this safe to deploy to mainnet?', 'Who can take the funds out?'],
	},
	{
		id: 'tester', name: 'Test Writer', color: '#5B4BFF', glyph: 'TW', builtin: true,
		summary: 'Writes Foundry tests and runs them until they pass',
		role: 'Write Foundry tests in test/ that cover normal use, failures (reverts) and edge cases, then run them and fix the tests until they pass. Only change the contract if a test shows a real bug — and say so.',
		rules: ['One behaviour per test, with a clear name.', 'Test reverts with their reason.', 'Never weaken a test just to make it pass.'],
		can: { read: true, write: true, build: true, test: true, run: false }, approval: 'auto', check: true,
		starters: ['Write tests for every contract', 'Cover the edge cases of withdraw()', 'Why does this test fail?'],
	},
	{
		id: 'explainer', name: 'Explainer', color: '#36F5FF', glyph: 'EX', builtin: true,
		summary: 'Explains code and blockchain ideas in simple words',
		role: 'Explain how the code and Lightchain work to someone new to blockchains: what each part does, why, and what to try next. Use short sentences and everyday examples. Never change files.',
		rules: ['Avoid jargon, or explain it the first time.', 'Use small examples.', 'End with one suggested next step.'],
		can: { read: true, write: false, build: false, test: false, run: false }, approval: 'ask', check: false,
		starters: ['What does this contract do?', 'What is gas and who pays it?', 'How do I let users pay in LCAI?'],
	},
];

/** Agents saved before they became Markdown files; still read, moved on the next save. */
const LEGACY_FILE = '.lightchain/agents.json';
export const AGENTS_DIR = '.lightchain/agents';

const TOOL_KEYS = ['read', 'write', 'build', 'test', 'run'] as const;

/** An agent as a Markdown file: front matter for the switches, then its job and a "## Rules" list. */
export function profileToMarkdown(p: AgentProfile): string {
	const body = [p.role.trim(), ...(p.rules.filter(r => r.trim()).length ? ['## Rules', p.rules.filter(r => r.trim()).map(r => `- ${r.trim()}`).join('\n')] : [])].filter(Boolean).join('\n\n');
	return formatFrontMatter({
		name: p.name,
		description: p.summary,
		tools: TOOL_KEYS.filter(k => p.can[k]),
		approval: p.approval,
		check: p.check,
		model: p.model,
		color: p.color,
		starters: p.starters.filter(Boolean).length ? p.starters.filter(Boolean) : undefined,
	}, body);
}

/** Reads an agent from Markdown. The file name is its id; everything else has a sensible default. */
export function profileFromMarkdown(id: string, text: string): AgentProfile | undefined {
	const { data, body } = parseFrontMatter(text);
	const str = (k: string) => typeof data[k] === 'string' ? data[k] as string : '';
	const list = (k: string) => Array.isArray(data[k]) ? data[k] as string[] : str(k) ? str(k).split(',').map(x => x.trim()).filter(Boolean) : undefined;
	// "## Rules" bullets become the agent's rules; any other text is its job
	const lines = body.split('\n');
	const at = lines.findIndex(l => /^#{1,6}\s+rules\s*$/i.test(l.trim()));
	const role: string[] = at < 0 ? lines : lines.slice(0, at);
	const rules: string[] = [];
	if (at >= 0) {
		let inRules = true;
		for (const line of lines.slice(at + 1)) {
			const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
			if (inRules && bullet) {
				rules.push(bullet[1].trim());
			} else if (line.trim()) {
				inRules = false;
				role.push(line);
			}
		}
	}
	const tools = list('tools');
	const name = str('name') || id.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase());
	return normalizeProfile({
		id, name,
		summary: str('description'),
		color: str('color'),
		role: role.join('\n').trim(),
		rules,
		can: tools ? Object.fromEntries(TOOL_KEYS.map(k => [k, tools.includes(k)])) : { read: true, write: true, build: true, test: true, run: false },
		approval: str('approval'),
		check: data.check === undefined ? !!tools?.includes('build') || !tools : data.check === true,
		model: str('model'),
		starters: list('starters'),
	});
}

/** Tool names an agent may use. */
export function allowedTools(p: AgentProfile): string[] {
	return [
		...(p.can.read ? ['list_dir', 'read_file', 'search'] : []),
		...(p.can.write ? ['write_file'] : []),
		...(p.can.build ? ['forge_build'] : []),
		...(p.can.test ? ['forge_test'] : []),
		...(p.can.run ? ['run_command'] : []),
	];
}

/** The agent's part of the system prompt. */
export function profilePrompt(p: AgentProfile): string {
	return [
		`You are the "${p.name}" agent. ${p.role}`,
		...(p.rules.length ? ['Rules you always follow:', ...p.rules.map(r => `- ${r}`)] : []),
		...(!p.can.write ? ['You must not change any files; answer in the chat.'] : []),
	].join('\n');
}

/** The steps of an agent's way of working, for the visual flow. */
export interface FlowStep { id: 'understand' | 'read' | 'plan' | 'write' | 'build' | 'test' | 'answer'; label: string; detail: string; on: boolean }

export function flow(p: AgentProfile): FlowStep[] {
	return [
		{ id: 'understand', label: 'Understand', detail: 'Reads your request, the open file and the project map', on: true },
		{ id: 'read', label: 'Read code', detail: 'Opens and searches the project files it needs', on: p.can.read },
		{ id: 'plan', label: 'Plan', detail: 'Decides what to do, in a few steps', on: true },
		{ id: 'write', label: 'Change files', detail: p.can.write ? (p.approval === 'ask' ? 'Shows each change — you accept or reject' : 'Applies changes — you can undo them') : 'Not allowed: answers in the chat only', on: p.can.write },
		{ id: 'build', label: 'Build', detail: p.check ? 'Compiles after every contract change and fixes errors' : 'Compiles when it needs to', on: p.can.build },
		{ id: 'test', label: 'Test', detail: p.check ? 'Runs the tests and fixes failures' : 'Runs tests when asked', on: p.can.test },
		{ id: 'answer', label: 'Summarise', detail: 'Tells you what it did and what to try next', on: true },
	];
}

export function normalizeProfile(raw: any): AgentProfile | undefined {
	if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') {
		return undefined;
	}
	const can = raw.can ?? {};
	return {
		id: raw.id.slice(0, 40), name: raw.name.slice(0, 40),
		color: /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : '#7130C3',
		glyph: String(raw.glyph ?? raw.name.slice(0, 2)).slice(0, 2).toUpperCase(),
		summary: String(raw.summary ?? '').slice(0, 120),
		role: String(raw.role ?? '').slice(0, 2000),
		rules: Array.isArray(raw.rules) ? raw.rules.filter((r: unknown) => typeof r === 'string' && r.trim()).map((r: string) => r.slice(0, 200)).slice(0, 12) : [],
		can: { read: can.read !== false, write: !!can.write, build: !!can.build, test: !!can.test, run: !!can.run },
		approval: raw.approval === 'auto' ? 'auto' : 'ask',
		check: !!raw.check,
		model: typeof raw.model === 'string' && raw.model ? raw.model : undefined,
		starters: Array.isArray(raw.starters) ? raw.starters.filter((s: unknown) => typeof s === 'string').slice(0, 4) : [],
	};
}

export class AgentProfiles implements vscode.Disposable {
	private custom: AgentProfile[] = [];
	private legacy = new Set<string>(); // ids still stored in agents.json
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly disposables: vscode.Disposable[] = [this.changed];
	private writing = false;
	private loading?: Promise<void>;

	constructor() {
		const root = this.root;
		if (root) {
			const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '.lightchain/{agents.json,agents/*.md}'));
			const reload = () => { if (!this.writing) { void this.load(); } };
			this.disposables.push(w, w.onDidChange(reload), w.onDidCreate(reload), w.onDidDelete(reload));
		}
		void this.load();
	}

	private get root(): vscode.Uri | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri;
	}

	get all(): AgentProfile[] {
		// a project agent with a built-in's id overrides it
		return [
			...BUILTIN_AGENTS.map(b => this.custom.find(c => c.id === b.id) ?? b), // edited built-ins keep their place
			...this.custom.filter(c => !BUILTIN_AGENTS.some(b => b.id === c.id)),
		];
	}

	get(id: string | undefined): AgentProfile {
		return this.all.find(p => p.id === id) ?? BUILTIN_AGENTS[0];
	}

	/** The agent's Markdown file (it exists once the agent has been saved for this project). */
	fileOf(id: string): vscode.Uri | undefined {
		return this.root && vscode.Uri.joinPath(this.root, AGENTS_DIR, `${slug(id, 'agent')}.md`);
	}

	/** An id for a new agent called `name`, free among the existing ones. */
	newId(name: string): string {
		return uniqueSlug(name, this.all.map(p => p.id), 'agent');
	}

	/** Resolves once the project's agents have been read. */
	ready(): Promise<void> {
		return this.loading ?? Promise.resolve();
	}

	private load(): Promise<void> {
		return this.loading = this.read().finally(() => this.changed.fire());
	}

	private async read(): Promise<void> {
		const root = this.root;
		const found = new Map<string, AgentProfile>();
		this.legacy = new Set();
		if (!root) {
			this.custom = [];
			return;
		}
		try {
			const raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, LEGACY_FILE))));
			for (const p of (Array.isArray(raw?.agents) ? raw.agents.map(normalizeProfile).filter(Boolean) : []) as AgentProfile[]) {
				found.set(p.id, p);
				this.legacy.add(p.id);
			}
		} catch { /* no legacy file */ }
		try {
			const dir = vscode.Uri.joinPath(root, AGENTS_DIR);
			const names = (await vscode.workspace.fs.readDirectory(dir)).filter(([n, t]) => t !== vscode.FileType.Directory && n.toLowerCase().endsWith('.md')).map(([n]) => n).sort();
			for (const name of names) {
				const id = slug(name.replace(/\.md$/i, ''), 'agent');
				const p = profileFromMarkdown(id, new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name))));
				if (p) {
					found.set(id, p); // a Markdown file wins over the legacy entry
				}
			}
		} catch { /* no agents folder */ }
		this.custom = [...found.values()];
	}

	private async hold<T>(work: () => Promise<T>): Promise<T> {
		this.writing = true;
		try {
			return await work();
		} finally {
			setTimeout(() => { this.writing = false; }, 300);
		}
	}

	/** Rewrites agents.json without the agents that now live in Markdown (removes it when empty). */
	private async saveLegacy(root: vscode.Uri): Promise<void> {
		const file = vscode.Uri.joinPath(root, LEGACY_FILE);
		const left = this.custom.filter(c => this.legacy.has(c.id));
		if (left.length) {
			await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(JSON.stringify({ version: 1, agents: left.map(({ builtin: _b, ...p }) => p) }, null, '\t') + '\n'));
		} else {
			await Promise.resolve(vscode.workspace.fs.delete(file)).catch(() => undefined);
		}
	}

	/** Saves an agent as .lightchain/agents/<id>.md (a changed built-in becomes a project copy with the same id). */
	async put(p: AgentProfile): Promise<void> {
		const clean = normalizeProfile({ ...p, id: slug(String(p?.id ?? ''), 'agent') });
		const root = this.root;
		if (!clean) {
			return;
		}
		if (!root) {
			throw new Error('Open a project to save agents with it.');
		}
		const i = this.custom.findIndex(c => c.id === clean.id);
		if (i >= 0) {
			this.custom[i] = clean;
		} else {
			this.custom.push(clean);
		}
		await this.hold(async () => {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, AGENTS_DIR));
			await vscode.workspace.fs.writeFile(this.fileOf(clean.id)!, new TextEncoder().encode(profileToMarkdown(clean)));
			if (this.legacy.delete(clean.id)) {
				await this.saveLegacy(root);
			}
		});
		this.changed.fire();
	}

	async remove(id: string): Promise<void> {
		const root = this.root;
		this.custom = this.custom.filter(c => c.id !== id);
		if (root) {
			await this.hold(async () => {
				await Promise.resolve(vscode.workspace.fs.delete(this.fileOf(id)!)).catch(() => undefined);
				if (this.legacy.delete(id)) {
					await this.saveLegacy(root);
				}
			});
		}
		this.changed.fire();
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

	isCustomized(id: string): boolean {
		return BUILTIN_AGENTS.some(b => b.id === id) && this.custom.some(c => c.id === id);
	}
}

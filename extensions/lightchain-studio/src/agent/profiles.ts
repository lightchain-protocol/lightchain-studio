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
	/** Where a saved agent lives: with the project (shared through git) or with the wallet (personal, in all its projects). */
	scope?: Scope;
}

export type Scope = 'project' | 'personal';

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
		description: p.summary || undefined,
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
export interface FlowStep { id: 'understand' | 'read' | 'plan' | 'write' | 'build' | 'test' | 'answer'; label: string; /** one word, for the chat's progress strip */ short: string; detail: string; on: boolean }

export function flow(p: AgentProfile): FlowStep[] {
	return [
		{ id: 'understand', short: 'Understand', label: 'Understands your request', detail: 'Reads what you asked, the file you have open and your project\'s instructions', on: true },
		{ id: 'read', short: 'Read', label: 'Looks at your project', detail: 'Opens and searches the files it needs', on: p.can.read },
		{ id: 'plan', short: 'Plan', label: 'Makes a plan', detail: 'Decides what to do, following its rules', on: true },
		{ id: 'write', short: 'Change', label: 'Changes your files', detail: p.can.write ? (p.approval === 'ask' ? 'Shows you each change — you accept or reject it' : 'Makes the changes — you can undo them') : 'Not allowed: it only answers in the chat', on: p.can.write },
		{ id: 'build', short: 'Check', label: 'Checks the code works', detail: p.can.build ? (p.check ? 'Compiles the contracts after every change and fixes errors' : 'Compiles the contracts when it needs to') : 'Not allowed', on: p.can.build },
		{ id: 'test', short: 'Test', label: 'Runs the tests', detail: p.can.test ? (p.check ? 'Runs your tests after every change and fixes failures' : 'Runs your tests when you ask') : 'Not allowed', on: p.can.test },
		{ id: 'answer', short: 'Summarise', label: 'Tells you what it did', detail: 'A short summary, and what to try next', on: true },
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
	private personalWatch?: vscode.Disposable;
	private writing = false;
	private loading?: Promise<void>;

	/**
	 * `personalDir`: the active wallet's folder for personal agents (undefined without a wallet);
	 * `onSpaceChange`: fires when another wallet becomes active.
	 */
	constructor(private readonly personalDir: () => vscode.Uri | undefined = () => undefined, onSpaceChange?: vscode.Event<void>) {
		const root = this.root;
		const reload = () => { if (!this.writing) { void this.load(); } };
		if (root) {
			const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '.lightchain/{agents.json,agents/*.md}'));
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
		return dir && vscode.Uri.joinPath(dir, 'agents');
	}

	/** Which places an agent can be saved to right now. */
	get scopes(): Scope[] {
		return [...(this.root ? ['project' as const] : []), ...(this.personalFolder ? ['personal' as const] : [])];
	}

	get all(): AgentProfile[] {
		// a saved agent with a built-in's id overrides it
		return [
			...BUILTIN_AGENTS.map(b => this.custom.find(c => c.id === b.id) ?? b), // edited built-ins keep their place
			// then the wallet's own, then the project's
			...this.custom.filter(c => !BUILTIN_AGENTS.some(b => b.id === c.id)).sort((a, b) => Number(a.scope !== 'personal') - Number(b.scope !== 'personal')),
		];
	}

	get(id: string | undefined): AgentProfile {
		return this.all.find(p => p.id === id) ?? BUILTIN_AGENTS[0];
	}

	private folder(scope: Scope): vscode.Uri | undefined {
		return scope === 'personal' ? this.personalFolder : this.root && vscode.Uri.joinPath(this.root, AGENTS_DIR);
	}

	/** The agent's Markdown file (it exists once the agent has been saved). */
	fileOf(id: string, scope?: Scope): vscode.Uri | undefined {
		const where = this.folder(scope ?? this.custom.find(c => c.id === id)?.scope ?? this.scopes[0] ?? 'project');
		return where && vscode.Uri.joinPath(where, `${slug(id, 'agent')}.md`);
	}

	/** An id for a new agent called `name`, free among the existing ones. */
	newId(name: string): string {
		return uniqueSlug(name, this.all.map(p => p.id), 'agent');
	}

	/** Resolves once the saved agents have been read. */
	ready(): Promise<void> {
		return this.loading ?? Promise.resolve();
	}

	private load(): Promise<void> {
		return this.loading = this.read().finally(() => this.changed.fire());
	}

	private async readFolder(dir: vscode.Uri | undefined, scope: Scope, found: Map<string, AgentProfile>): Promise<void> {
		if (!dir) {
			return;
		}
		try {
			const names = (await vscode.workspace.fs.readDirectory(dir)).filter(([n, t]) => t !== vscode.FileType.Directory && n.toLowerCase().endsWith('.md')).map(([n]) => n).sort();
			for (const name of names) {
				const id = slug(name.replace(/\.md$/i, ''), 'agent');
				const p = profileFromMarkdown(id, new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name))));
				if (p) {
					found.set(id, { ...p, scope });
				}
			}
		} catch { /* no such folder yet */ }
	}

	private async read(): Promise<void> {
		const root = this.root;
		const found = new Map<string, AgentProfile>();
		this.legacy = new Set();
		// the wallet's own agents first; a project's agent with the same id wins (the team's version)
		await this.readFolder(this.personalFolder, 'personal', found);
		if (root) {
			try {
				const raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, LEGACY_FILE))));
				for (const p of (Array.isArray(raw?.agents) ? raw.agents.map(normalizeProfile).filter(Boolean) : []) as AgentProfile[]) {
					found.set(p.id, { ...p, scope: 'project' });
					this.legacy.add(p.id);
				}
			} catch { /* no legacy file */ }
			await this.readFolder(vscode.Uri.joinPath(root, AGENTS_DIR), 'project', found);
		}
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
			await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(JSON.stringify({ version: 1, agents: left.map(({ builtin: _b, scope: _s, ...p }) => p) }, null, '\t') + '\n'));
		} else {
			await Promise.resolve(vscode.workspace.fs.delete(file)).catch(() => undefined);
		}
	}

	/**
	 * Saves an agent as Markdown, with the project (.lightchain/agents/<id>.md) or with the wallet.
	 * Without `scope` it stays where it is; a new one goes to the project when one is open.
	 * A changed built-in becomes a saved copy with the same id.
	 */
	async put(p: AgentProfile, scope?: Scope): Promise<void> {
		const clean = normalizeProfile({ ...p, id: slug(String(p?.id ?? ''), 'agent') });
		if (!clean) {
			return;
		}
		const had = this.custom.find(c => c.id === clean.id);
		const where = scope ?? had?.scope ?? this.scopes[0];
		const dir = where && this.folder(where);
		if (!where || !dir) {
			throw new Error(scope === 'personal' ? 'Connect a wallet to keep agents with it.' : 'Open a project or connect a wallet to save agents.');
		}
		const saved: AgentProfile = { ...clean, scope: where };
		this.custom = had ? this.custom.map(c => c.id === clean.id ? saved : c) : [...this.custom, saved];
		await this.hold(async () => {
			await vscode.workspace.fs.createDirectory(dir);
			await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, `${clean.id}.md`), new TextEncoder().encode(profileToMarkdown(clean)));
			// moved between the project and the wallet: it lives in one place only
			if (had?.scope && had.scope !== where) {
				const old = this.folder(had.scope);
				if (old) {
					await Promise.resolve(vscode.workspace.fs.delete(vscode.Uri.joinPath(old, `${clean.id}.md`))).catch(() => undefined);
				}
			}
			if (this.legacy.delete(clean.id) && this.root) {
				await this.saveLegacy(this.root);
			}
		});
		this.changed.fire();
	}

	async remove(id: string): Promise<void> {
		const had = this.custom.find(c => c.id === id);
		this.custom = this.custom.filter(c => c.id !== id);
		await this.hold(async () => {
			const dir = had?.scope && this.folder(had.scope);
			if (dir) {
				await Promise.resolve(vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, `${slug(id, 'agent')}.md`))).catch(() => undefined);
			}
			if (this.legacy.delete(id) && this.root) {
				await this.saveLegacy(this.root);
			}
		});
		// the same id may exist in the other place (a wallet's agent under a project's): show it again
		await this.load();
	}

	dispose(): void {
		this.personalWatch?.dispose();
		this.disposables.forEach(d => d.dispose());
	}

	isCustomized(id: string): boolean {
		return BUILTIN_AGENTS.some(b => b.id === id) && this.custom.some(c => c.id === id);
	}
}

// ---- agents for people who do not think in tools and permissions ----------------------

/** How much an agent may do on its own, as one plain choice. */
export type Access = 'answer' | 'suggest' | 'auto';

export function accessOf(p: Pick<AgentProfile, 'can' | 'approval'>): Access {
	return !p.can.write ? 'answer' : p.approval === 'auto' ? 'auto' : 'suggest';
}

/** The switches behind each choice. Running terminal commands stays an advanced, separate switch. */
export function withAccess<T extends Pick<AgentProfile, 'can' | 'approval' | 'check'>>(p: T, access: Access): T {
	return access === 'answer'
		? { ...p, can: { ...p.can, read: true, write: false, test: false }, approval: 'ask', check: false }
		: { ...p, can: { ...p.can, read: true, write: true, build: true, test: true }, approval: access === 'auto' ? 'auto' : 'ask', check: true };
}

/** What an agent does, in one or two everyday sentences. */
export function describeAgent(p: AgentProfile): string {
	const checks = [p.can.build && 'checks that the code still works', p.can.test && 'runs the tests'].filter(Boolean).join(' and ');
	if (!p.can.write) {
		return `It looks at your project${p.can.build ? ' and can check that the code works' : ''}, and answers in the chat. It never changes your files.`;
	}
	const after = p.check && checks ? ` After every change it ${checks}, and fixes what it broke.` : '';
	return p.approval === 'auto'
		? `It makes changes on its own — you can undo any of them from the chat.${after}`
		: `It shows you each change and waits for your OK before anything is saved.${after}`;
}

export interface AgentDraft { name: string; summary: string; role: string; rules: string[]; access: Access; starters: string[] }

/** Ready-made ideas offered when creating an agent. */
export const AGENT_TEMPLATES: (AgentDraft & { id: string })[] = [
	{
		id: 'reviewer', name: 'Code Reviewer', summary: 'Reads your changes and says what could go wrong', access: 'answer',
		role: 'Review the code like a careful colleague. Point out bugs, unclear names and missing checks, and say why each one matters. Never change files.',
		rules: ['Point at the exact line.', 'Start with the most important problem.', 'Say what is good, too.'],
		starters: ['Review the contract I have open', 'What would you change before launch?'],
	},
	{
		id: 'gas-saver', name: 'Gas Saver', summary: 'Finds where a contract costs more than it should', access: 'suggest',
		role: 'Find where contracts waste gas: storage writes in loops, values read again and again, types that are bigger than needed. Explain each saving in plain words, then make the change.',
		rules: ['Never change what the contract does.', 'Explain the saving before changing anything.'],
		starters: ['Where does this contract waste gas?', 'Make the transfer function cheaper'],
	},
	{
		id: 'docs-writer', name: 'Docs Writer', summary: 'Explains your contracts in comments and a README', access: 'suggest',
		role: 'Write clear documentation: a comment above every function saying what it does and who may call it, and a README that explains the project to someone new.',
		rules: ['Use short sentences.', 'Never change the code itself, only comments and Markdown files.'],
		starters: ['Document every function in this contract', 'Write a README for this project'],
	},
	{
		id: 'launch-helper', name: 'Launch Helper', summary: 'Walks you through putting a contract on Lightchain', access: 'answer',
		role: 'Guide the user through deploying to Lightchain testnet and then mainnet, one step at a time: what to check first, what each step costs, and how to confirm it worked. Ask before moving to the next step.',
		rules: ['Always start on testnet.', 'Explain every cost in LCAI.', 'One step at a time.'],
		starters: ['Help me deploy this to testnet', 'What should I check before mainnet?'],
	},
	{
		id: 'tutor', name: 'Tutor', summary: 'Teaches blockchain development with your own project', access: 'answer',
		role: 'Teach the user to build on Lightchain using their own project as the example. Explain one idea at a time, check they followed, and give a small exercise. Never write the answer for them unless they ask.',
		rules: ['Avoid jargon, or explain it the first time.', 'End with one small exercise.'],
		starters: ['Teach me how this contract works', 'What should I learn next?'],
	},
];

/** A draft made on this machine from a description (no AI): good enough to adjust, never wrong about safety. */
export function draftFromText(description: string): AgentDraft {
	const text = description.trim().replace(/\s+/g, ' ');
	const words = text.replace(/^(an?|the)\s+(agent|helper|assistant)\s+(that|which|to|who)\s+/i, '').replace(/^(i (want|need)|please|create|make)\s+(an?\s+)?((agent|helper|assistant)\s+)?(that|which|to|who)?\s*/i, '');
	const about = words.toLowerCase();
	const readOnly = /\b(review|audit|explain|teach|check|find|look for|answer|guide|advis|tell me|never change|read[- ]only)/.test(about) && !/\b(fix|write|add|creat|chang|updat|refactor|generat|make|build)/.test(about);
	// a name people would give it: what it works on + what it does ("Gas Finder", "Contract Reviewer")
	const role = ([['audit', 'Auditor'], ['review', 'Reviewer'], ['explain', 'Explainer'], ['teach', 'Tutor'], ['document', 'Writer'], ['fix', 'Fixer'], ['optimi', 'Optimizer'], ['check', 'Checker'], ['find', 'Finder'], ['deploy', 'Helper'], ['write', 'Writer'], ['test', 'Tester']] as const).find(([verb]) => new RegExp(`\\b${verb}`).test(about))?.[1];
	const topic = ([['gas', 'Gas'], ['secur', 'Security'], ['test', 'Test'], ['doc', 'Docs'], ['readme', 'Docs'], ['token', 'Token'], ['contract', 'Contract'], ['deploy', 'Deploy']] as const).find(([word, label]) => new RegExp(`\\b${word}`).test(about) && !role?.startsWith(label))?.[1];
	const plain = (words.match(/[A-Za-z][A-Za-z0-9-]*/g) ?? []).filter(w => w.length > 2 && !/^(that|which|and|the|for|with|our|all|any|where|what|when|how|each|every|before|after|find|check|make|help|does|can|should|will)$/i.test(w)).slice(0, 2).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
	const name = (role ? `${topic ?? plain.split(' ')[0] ?? ''} ${role}`.trim() : topic ? `${topic} Helper` : plain) || 'New agent';
	const sentence = words ? words[0].toUpperCase() + words.slice(1) : '';
	return {
		name: name.slice(0, 40),
		summary: (sentence.length > 110 ? sentence.slice(0, 107) + '…' : sentence).replace(/\.$/, ''),
		role: sentence ? `${sentence.replace(/\.$/, '')}.${readOnly ? ' Never change files; answer in the chat.' : ''}` : '',
		rules: [],
		access: readOnly ? 'answer' : 'suggest',
		starters: [],
	};
}

/** Asks the model to design an agent from a description. */
export function draftPrompt(description: string): string {
	return [
		'Design a coding helper ("agent") for Lightchain Studio, an IDE for building smart contracts (Solidity, Foundry) on the Lightchain AI blockchain.',
		`The user describes the helper they want: "${description.trim().slice(0, 600)}"`,
		'',
		'Reply with ONLY a JSON object, no other text:',
		'{"name": "2-3 words", "summary": "one short line", "role": "2-4 sentences telling the agent what to do, addressed to the agent", "rules": ["up to 4 short rules"], "access": "answer | suggest | auto", "starters": ["2-3 example requests a user could click"]}',
		'',
		'access: "answer" if it should only read and explain and never change files; "suggest" if it changes files and the user approves each change (the default); "auto" only if the user clearly asks for it to work without asking.',
	].join('\n');
}

/** Reads the model's reply to `draftPrompt`; undefined when it is not usable. */
export function parseDraft(reply: string): AgentDraft | undefined {
	const start = reply.indexOf('{');
	const end = reply.lastIndexOf('}');
	if (start < 0 || end <= start) {
		return undefined;
	}
	try {
		const raw = JSON.parse(reply.slice(start, end + 1));
		const str = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : '';
		const list = (v: unknown, n: number, max: number) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim().slice(0, max)).slice(0, n) : [];
		const name = str(raw.name, 40);
		const role = str(raw.role, 2_000);
		if (!name || !role) {
			return undefined;
		}
		const access = String(raw.access ?? '').trim().toLowerCase();
		return { name, summary: str(raw.summary, 120), role, rules: list(raw.rules, 6, 200), access: access === 'answer' || access === 'auto' ? access : 'suggest', starters: list(raw.starters, 3, 120) };
	} catch {
		return undefined;
	}
}

/** A full agent from a draft. */
export function profileFromDraft(id: string, d: AgentDraft): AgentProfile {
	const base: AgentProfile = { id, name: d.name || 'New agent', color: '#7130C3', glyph: (d.name || 'NA').slice(0, 2).toUpperCase(), summary: d.summary, role: d.role, rules: d.rules, can: { read: true, write: false, build: true, test: false, run: false }, approval: 'ask', check: false, starters: d.starters };
	return withAccess(base, d.access);
}

import * as vscode from 'vscode';

/**
 * Lightchain AI agents people can understand and shape without code: a role in
 * plain words, rules as sentences, switches for what the agent may do and when it
 * must ask. Built-in agents plus the project's own (.lightchain/agents.json).
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

const FILE = '.lightchain/agents.json';

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
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly disposables: vscode.Disposable[] = [this.changed];
	private writing = false;

	constructor() {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (root) {
			const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, FILE));
			const reload = () => { if (!this.writing) { void this.load(); } };
			this.disposables.push(w, w.onDidChange(reload), w.onDidCreate(reload), w.onDidDelete(reload));
		}
		void this.load();
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

	private async load(): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		try {
			const raw = root ? JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, FILE)))) : undefined;
			this.custom = Array.isArray(raw?.agents) ? raw.agents.map(normalizeProfile).filter(Boolean) : [];
		} catch {
			this.custom = [];
		}
		this.changed.fire();
	}

	private async save(): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!root) {
			throw new Error('Open a project to save agents with it.');
		}
		this.writing = true;
		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, '.lightchain'));
			await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, FILE), new TextEncoder().encode(JSON.stringify({ version: 1, agents: this.custom.map(({ builtin: _b, ...p }) => p) }, null, '\t') + '\n'));
		} finally {
			setTimeout(() => { this.writing = false; }, 300);
		}
		this.changed.fire();
	}

	/** Saves an agent (a changed built-in becomes a project copy with the same id). */
	async put(p: AgentProfile): Promise<void> {
		const clean = normalizeProfile(p);
		if (!clean) {
			return;
		}
		const i = this.custom.findIndex(c => c.id === clean.id);
		if (i >= 0) {
			this.custom[i] = clean;
		} else {
			this.custom.push(clean);
		}
		await this.save();
	}

	async remove(id: string): Promise<void> {
		this.custom = this.custom.filter(c => c.id !== id);
		await this.save();
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

	isCustomized(id: string): boolean {
		return BUILTIN_AGENTS.some(b => b.id === id) && this.custom.some(c => c.id === id);
	}
}

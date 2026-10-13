import * as vscode from 'vscode';

/**
 * Project tasks (a small Jira-style board): stored in .lightchain/tasks.json in
 * the project, so they travel with the code and a team shares them through git.
 */
export type TaskStatus = 'todo' | 'doing' | 'review' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface Task {
	id: string;
	key: number;          // LC-1, LC-2… (stable, per project)
	title: string;
	description?: string;
	status: TaskStatus;
	priority: TaskPriority;
	labels: string[];
	created: number;
	updated: number;
	chat?: string;        // the Lightchain AI chat working on it
}

export const STATUSES: { id: TaskStatus; label: string }[] = [
	{ id: 'todo', label: 'To do' },
	{ id: 'doing', label: 'In progress' },
	{ id: 'review', label: 'Review' },
	{ id: 'done', label: 'Done' },
];

interface TaskFile { version: 1; next: number; tasks: Task[] }

const FILE = '.lightchain/tasks.json';

export class TaskStore implements vscode.Disposable {
	private data: TaskFile = { version: 1, next: 1, tasks: [] };
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly disposables: vscode.Disposable[] = [this.changed];
	private writing = false;

	constructor() {
		const root = this.root;
		if (root) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, FILE));
			const reload = () => { if (!this.writing) { void this.load(); } };
			this.disposables.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload), watcher.onDidDelete(reload));
		}
		void this.load();
	}

	private get root(): vscode.Uri | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri;
	}

	get all(): Task[] {
		return this.data.tasks;
	}

	get prefix(): string {
		return 'LC';
	}

	private async load(): Promise<void> {
		const root = this.root;
		if (!root) {
			return;
		}
		try {
			const raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, FILE))));
			this.data = normalize(raw);
		} catch {
			this.data = { version: 1, next: 1, tasks: [] };
		}
		this.changed.fire();
	}

	private async save(): Promise<void> {
		const root = this.root;
		if (!root) {
			return;
		}
		this.writing = true;
		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, '.lightchain'));
			await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, FILE), new TextEncoder().encode(JSON.stringify(this.data, null, '\t') + '\n'));
		} finally {
			setTimeout(() => { this.writing = false; }, 300); // ignore our own watcher event
		}
		this.changed.fire();
	}

	async add(input: { title: string; description?: string; status?: TaskStatus; priority?: TaskPriority; labels?: string[] }): Promise<Task> {
		const now = Date.now();
		const task: Task = {
			id: `t${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
			key: this.data.next++,
			title: input.title.trim().slice(0, 200) || 'Untitled task',
			description: input.description?.trim() || undefined,
			status: input.status ?? 'todo',
			priority: input.priority ?? 'medium',
			labels: (input.labels ?? []).map(l => l.trim()).filter(Boolean).slice(0, 6),
			created: now,
			updated: now,
		};
		this.data.tasks.push(task);
		await this.save();
		return task;
	}

	async addMany(items: { title: string; description?: string }[]): Promise<number> {
		for (const i of items) {
			const now = Date.now();
			this.data.tasks.push({ id: `t${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, key: this.data.next++, title: i.title.slice(0, 200), description: i.description, status: 'todo', priority: 'medium', labels: [], created: now, updated: now });
		}
		await this.save();
		return items.length;
	}

	async update(id: string, patch: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'labels' | 'chat'>>): Promise<Task | undefined> {
		const t = this.data.tasks.find(x => x.id === id);
		if (!t) {
			return undefined;
		}
		Object.assign(t, patch, { updated: Date.now() });
		await this.save();
		return t;
	}

	/** Moves a task to `status`, placed before `beforeId` (or at the end of the column). */
	async move(id: string, status: TaskStatus, beforeId?: string): Promise<void> {
		const i = this.data.tasks.findIndex(x => x.id === id);
		if (i < 0) {
			return;
		}
		const [t] = this.data.tasks.splice(i, 1);
		t.status = status;
		t.updated = Date.now();
		const at = beforeId ? this.data.tasks.findIndex(x => x.id === beforeId) : -1;
		this.data.tasks.splice(at < 0 ? this.data.tasks.length : at, 0, t);
		await this.save();
	}

	async remove(id: string): Promise<void> {
		this.data.tasks = this.data.tasks.filter(x => x.id !== id);
		await this.save();
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}

export function normalize(raw: unknown): TaskFile {
	const r = raw as Partial<TaskFile> | undefined;
	const tasks = Array.isArray(r?.tasks) ? r!.tasks.filter(t => t && typeof t.id === 'string' && typeof t.title === 'string').map((t, i) => ({
		id: t.id,
		key: typeof t.key === 'number' ? t.key : i + 1,
		title: t.title,
		description: typeof t.description === 'string' ? t.description : undefined,
		status: (['todo', 'doing', 'review', 'done'] as const).includes(t.status) ? t.status : 'todo',
		priority: (['low', 'medium', 'high'] as const).includes(t.priority) ? t.priority : 'medium',
		labels: Array.isArray(t.labels) ? t.labels.filter((l: unknown) => typeof l === 'string') : [],
		created: typeof t.created === 'number' ? t.created : Date.now(),
		updated: typeof t.updated === 'number' ? t.updated : Date.now(),
		chat: typeof t.chat === 'string' ? t.chat : undefined,
	} as Task)) : [];
	const next = Math.max(typeof r?.next === 'number' ? r.next : 1, ...tasks.map(t => t.key + 1));
	return { version: 1, next, tasks };
}

/** The chat instruction for working on a task. */
export function taskPrompt(t: Task, prefix = 'LC'): string {
	return `Work on task ${prefix}-${t.key}: ${t.title}${t.description ? `\n\n${t.description}` : ''}\n\nPlan briefly, make the changes, build and test them, then summarise what you did.`;
}

/** Tasks from a "- [ ] title — detail" checklist (e.g. an answer to /plan). */
export function parseChecklist(text: string): { title: string; description?: string }[] {
	const out: { title: string; description?: string }[] = [];
	for (const m of text.matchAll(/^\s*(?:[-*]\s*\[[ xX]?\]|\d+[.)])\s+(.+)$/gm)) {
		const line = m[1].replace(/\*\*/g, '').trim();
		const [title, ...rest] = line.split(/\s+[—–-]\s+|:\s+/);
		if (title && title.length > 2) {
			out.push({ title: title.trim().slice(0, 120), description: rest.join(' — ').trim() || undefined });
		}
	}
	return out.slice(0, 20);
}

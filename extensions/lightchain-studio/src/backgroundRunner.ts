import * as vscode from 'vscode';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { InferenceProvider } from './agent/agent';
import { Work, WorkResult, discardWork, mergeWork, notReady, runInBackground } from './agent/background';
import type { AgentProfile } from './agent/profiles';
import { findForge } from './foundry';
import { Task, TaskStore, taskPrompt } from './tasks';

interface Finished extends Work { task: string; key: string; title: string; files: string[]; summary: string; ok: boolean; problem?: string }

const STATE = 'lightchain.background.finished';
/** One reply per step plus the fix rounds: what a run can cost at most. */
const MAX_REQUESTS = 15;

/**
 * Hands board tasks to Lightchain AI in the background. One task at a time; the
 * work lands on its own git branch and waits for the user to review, merge or
 * discard it (the choice survives a restart).
 */
export class BackgroundAgents implements vscode.Disposable {
	private running?: { task: Task; abort: AbortController; work?: Work };
	private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly tasks: TaskStore,
		private readonly provider: () => InferenceProvider | undefined,
		private readonly profile: () => AgentProfile | undefined,
		private readonly feePerRequest: number,
	) {
		this.status.command = 'lightchain.tasks.backgroundMenu';
		this.refresh();
	}

	private get root(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	private get finished(): Finished[] {
		return this.context.workspaceState.get<Finished[]>(STATE, []);
	}

	/** What the board shows on a task: working, or waiting for review. */
	stateOf(taskId: string): 'running' | 'ready' | 'problem' | undefined {
		if (this.running?.task.id === taskId) {
			return 'running';
		}
		const f = this.finished.find(x => x.task === taskId);
		return f ? (f.ok ? 'ready' : 'problem') : undefined;
	}

	private async setFinished(list: Finished[]): Promise<void> {
		await this.context.workspaceState.update(STATE, list);
		this.refresh();
	}

	private refresh(text?: string): void {
		const waiting = this.finished.length;
		if (this.running) {
			this.status.text = `$(sync~spin) ${this.tasks.prefix}-${this.running.task.key}: ${text ?? 'working in the background'}`.slice(0, 80);
			this.status.tooltip = 'Lightchain AI is working on this task on its own branch. Click to stop it or see finished work.';
			this.status.show();
		} else if (waiting) {
			this.status.text = `$(git-pull-request) ${waiting} background task${waiting === 1 ? '' : 's'} to review`;
			this.status.tooltip = 'Work Lightchain AI finished in the background, waiting for you to look at it.';
			this.status.show();
		} else {
			this.status.hide();
		}
		this.changed.fire();
	}

	async start(taskId?: string): Promise<void> {
		const root = this.root;
		if (!root) {
			vscode.window.showInformationMessage('Open a project to hand tasks to Lightchain AI.');
			return;
		}
		const open = this.tasks.all.filter(t => t.status !== 'done' && !this.stateOf(t.id));
		const task = taskId ? this.tasks.all.find(t => t.id === taskId) : (await vscode.window.showQuickPick(open.map(t => ({ label: `${this.tasks.prefix}-${t.key} · ${t.title}`, description: t.status, task: t })), { title: 'Which task should Lightchain AI do in the background?', placeHolder: open.length ? 'Pick a task' : 'No open tasks — add one on the task board first' }))?.task;
		if (!task) {
			return;
		}
		if (this.running) {
			vscode.window.showInformationMessage(`Lightchain AI is still working on ${this.tasks.prefix}-${this.running.task.key}. Background tasks run one at a time.`);
			return;
		}
		if (this.stateOf(task.id)) {
			return this.menu();
		}
		const blocked = await notReady(root);
		if (blocked) {
			const init = /not a git repository/.test(blocked) ? 'Set Up Git' : undefined;
			const pick = await vscode.window.showWarningMessage(blocked, ...(init ? [init] : []));
			if (pick) {
				await vscode.commands.executeCommand('git.init');
			}
			return;
		}
		const provider = this.provider();
		if (!provider) {
			vscode.window.showWarningMessage('Connect a wallet and pick a model so Lightchain AI can work on the task.');
			return;
		}
		const key = `${this.tasks.prefix}-${task.key}`;
		const go = await vscode.window.showInformationMessage(`Let Lightchain AI do ${key} in the background?`, {
			modal: true,
			detail: [
				`"${task.title}"`,
				'',
				'• It works on a separate git branch. Your files stay exactly as they are until you merge its work.',
				'• It saves its changes without asking, but never runs terminal commands.',
				`• It uses at most about ${MAX_REQUESTS} requests (≈ ${(MAX_REQUESTS * this.feePerRequest).toFixed(2)} LCAI of credits).`,
				'• You can keep working, and stop it from the status bar.',
			].join('\n'),
		}, 'Start');
		if (go !== 'Start') {
			return;
		}
		const abort = new AbortController();
		this.running = { task, abort };
		await this.tasks.update(task.id, { status: 'doing' });
		this.refresh('starting');
		const workDir = path.join(this.context.globalStorageUri.fsPath, 'work', createHash('sha1').update(root).digest('hex').slice(0, 12));
		let result: WorkResult | undefined;
		let failure: string | undefined;
		try {
			result = await runInBackground({
				root, workDir, key, title: task.title, prompt: taskPrompt(task, this.tasks.prefix), provider, forgePath: findForge(), profile: this.profile(), signal: abort.signal,
				onProgress: text => this.refresh(text.replace(/…$/, '')),
				onStart: work => { if (this.running) { this.running.work = work; } },
			});
		} catch (err) {
			failure = (err as Error).message.split('\n')[0];
		}
		const work = this.running?.work;
		this.running = undefined;
		if (!result) {
			if (work) {
				await discardWork(root, work).catch(() => undefined);
			}
			await this.tasks.update(task.id, { status: 'todo' });
			this.refresh();
			vscode.window.showErrorMessage(`${key} could not be started in the background: ${failure}`);
			return;
		}
		if (!result.files.length) {
			// nothing to review: clean up and say why
			await discardWork(root, result).catch(() => undefined);
			await this.tasks.update(task.id, { status: 'todo' });
			this.refresh();
			const setup = /delegate|not authori[sz]ed|allowance/i.test(result.problem ?? '');
			vscode.window.showWarningMessage(setup
				? `${key}: Lightchain AI may not use your credits yet. Send one message in the Lightchain AI chat and choose Allow, then start the task again.`
				: `${key}: ${result.problem ?? 'Lightchain AI finished without changing anything.'}${result.summary ? ` It said: ${result.summary.slice(0, 200)}` : ''}`);
			return;
		}
		await this.setFinished([...this.finished.filter(f => f.task !== task.id), { task: task.id, key, title: task.title, branch: result.branch, worktree: result.worktree, files: result.files, summary: result.summary, ok: result.ok, problem: result.problem }]);
		await this.tasks.update(task.id, { status: 'review' });
		const headline = result.ok ? `${key} is ready to review: ${result.files.length} file${result.files.length === 1 ? '' : 's'} changed.` : `${key} needs a look: ${result.problem}`;
		const pick = await (result.ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(headline, 'Review Changes', 'Later');
		if (pick === 'Review Changes') {
			await this.review(task.id);
		}
	}

	/** Stop the running task, or pick finished work to review, merge or discard. */
	async menu(): Promise<void> {
		type Item = vscode.QuickPickItem & { run?: () => unknown };
		const items: Item[] = [];
		if (this.running) {
			const r = this.running;
			items.push({ label: `$(debug-stop) Stop ${this.tasks.prefix}-${r.task.key}`, description: r.task.title, detail: 'What it has done so far is kept on its branch for you to review.', run: () => r.abort.abort() });
		}
		for (const f of this.finished) {
			items.push({ label: `${f.ok ? '$(pass)' : '$(warning)'} ${f.key} · ${f.title}`, description: `${f.files.length} file${f.files.length === 1 ? '' : 's'}`, detail: f.ok ? 'Ready to review' : f.problem, run: () => this.review(f.task) });
		}
		if (!items.length) {
			vscode.window.showInformationMessage('No background work right now. Hand a task to Lightchain AI from the task board.');
			return;
		}
		(await vscode.window.showQuickPick(items, { title: 'Background work' }))?.run?.();
	}

	/** Shows what the branch changes, then asks what to do with it. */
	async review(taskId: string): Promise<void> {
		const root = this.root;
		const f = this.finished.find(x => x.task === taskId);
		if (!root || !f) {
			return;
		}
		for (const file of f.files.slice(0, 6)) {
			const mine = vscode.Uri.file(path.join(root, file));
			const theirs = vscode.Uri.file(path.join(f.worktree, file));
			const exists = (u: vscode.Uri) => Promise.resolve(vscode.workspace.fs.stat(u)).then(() => true, () => false);
			if (await exists(theirs) && await exists(mine)) {
				await vscode.commands.executeCommand('vscode.diff', mine, theirs, `${f.key}: ${file} (yours ↔ Lightchain AI)`, { preview: false });
			} else if (await exists(theirs)) {
				await vscode.window.showTextDocument(theirs, { preview: false });
			}
		}
		const pick = await vscode.window.showInformationMessage(`${f.key}: ${f.ok ? 'take these changes into your project?' : f.problem}`, {
			modal: true,
			detail: [
				f.summary ? `Lightchain AI says: ${f.summary.slice(0, 600)}` : '',
				`Changed: ${f.files.slice(0, 10).join(', ')}${f.files.length > 10 ? ` and ${f.files.length - 10} more` : ''}`,
				`The work is on the git branch ${f.branch}.`,
			].filter(Boolean).join('\n\n'),
		}, 'Merge Into My Project', 'Discard');
		if (pick === 'Merge Into My Project') {
			const merged = await mergeWork(root, f);
			if (merged.ok) {
				await this.setFinished(this.finished.filter(x => x.task !== taskId));
				await this.tasks.update(taskId, { status: 'done' });
				vscode.window.showInformationMessage(`${f.key}: ${merged.message}`);
			} else {
				vscode.window.showWarningMessage(merged.message);
			}
		} else if (pick === 'Discard') {
			await discardWork(root, f).catch(() => undefined);
			await this.setFinished(this.finished.filter(x => x.task !== taskId));
			await this.tasks.update(taskId, { status: 'todo' });
		}
	}

	dispose(): void {
		this.running?.abort.abort();
		this.status.dispose();
		this.changed.dispose();
	}
}

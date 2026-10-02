import * as vscode from 'vscode';
import * as path from 'node:path';
import { applyHunks, lineDiff } from './agent/lineDiff';
import { ChatStore, ChatEvent } from './agent/chatStore';
import { runInlineEdit } from './agent/inlineEdit';
import { StuckJobs } from './lightchain/stuckJobs';
import { PromptContext, buildContext, editorContext, mentionableFiles } from './agent/context';
import { AgentStuckError } from './agent/agent';
import * as fs from 'node:fs';
import { NetworkState } from './networkState';
import { Wallet } from './wallet';
import { shortAddress } from './deployedPrograms';
import { Credits, formatLcai } from './credits';
import { Agent, InferenceProvider } from './agent/agent';
import { ApprovalRequest, PartialApproval } from './agent/tools';
import { ProposalStore } from './agent/proposals';
import { findForge } from './foundry';
import { DelegateNotAuthorizedError, InsufficientCreditsError, SubmitError, WorkerError } from './lightchain/inference';
import { LightchainModel, fetchModels, pickDefault } from './lightchain/models';

/**
 * Lightchain AI panel: chat with the Lightchain coding agent.
 * Styled only with lightchain.ai components (see fork-tools/theme), scaled to
 * the IDE's text size.
 */
/** No answer this long after the job was submitted → suggest another model. */
const SLOW_AFTER_MS = 45_000;

/** Escrowed per job on testnet today (JobRegistry fee); used for the pre-send credit check. */
const JOB_FEE_LCAI = 0.02;

export class LightchainAiView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view?: vscode.WebviewView;
	private readonly disposables: vscode.Disposable[] = [];
	private generation = 0;
	private agent?: Agent;
	private abort?: AbortController;
	private approvals = new Map<string, { resolve: (decision: boolean | PartialApproval) => void; req: ApprovalRequest }>();
	private seq = 0;
	private pendingDelegate?: `0x${string}`;
	private retryText?: string; // prompt to send again once a setup step (credits) is done
	private models: LightchainModel[] = [];
	private model?: string;
	private slowTimer?: ReturnType<typeof setTimeout>;
	/** Per turn: files the agent wrote, with their content before the turn (undefined = created). */
	private checkpoints = new Map<string, Map<string, { before?: string; after: string }>>();
	private currentTurn?: string;
	private autoRetried = false; // one automatic retry per request after a worker failure
	private lastCredits?: number; // LCAI, from the last balance read
	private readonly stuck: StuckJobs;
	private readonly chats: ChatStore;
	private recap?: string; // summary of a restored chat, sent with the next prompt (new worker session)
	private inFlight?: { text: string; job?: string }; // the prompt being answered right now

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly wallet: Wallet,
		private readonly network: NetworkState,
		private readonly credits: Credits,
		private readonly provider: (model: string) => InferenceProvider,
		private readonly proposals: ProposalStore,
		private readonly memento: vscode.Memento,
		workspaceState: vscode.Memento,
	) {
		this.chats = new ChatStore(workspaceState);
		this.stuck = new StuckJobs(memento, wallet);
		this.disposables.push(wallet.onDidChange(() => this.postState()), network.onDidChange(() => { this.resetChat(); this.refreshModels(); this.postState(); }), credits.onDidChange(() => this.postState()));
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage(msg => this.onMessage(msg), undefined, this.disposables);
		view.onDidChangeVisibility(() => { if (view.visible) { this.postState(); this.refreshModels(); } }, undefined, this.disposables);
		this.postState();
		this.refreshModels();
		// keep the composer's context chips in sync with the editor
		let t: ReturnType<typeof setTimeout> | undefined;
		const sync = () => { clearTimeout(t); t = setTimeout(() => this.post({ type: 'context', ...editorContext() }), 150); };
		this.disposables.push(vscode.window.onDidChangeActiveTextEditor(sync), vscode.window.onDidChangeTextEditorSelection(sync));
		sync();
	}

	private async refreshModels(): Promise<void> {
		try {
			this.models = await fetchModels(this.network.current);
		} catch {
			return; // offline — keep the last list
		}
		const chosen = this.memento.get<string>('lightchain.ai.model');
		// Keep the user's pick while it is still served (availability shows as its dot);
		// only fall back when nothing was picked or the model is gone.
		this.model = chosen && this.models.some(m => m.name === chosen) ? chosen : pickDefault(this.models, chosen);
		this.post({ type: 'models', models: this.models, selected: this.model });
	}

	private resetChat(): void {
		this.abort?.abort();
		this.agent = undefined;
		this.recap = undefined;
		void this.chats.startNew();
		this.post({ type: 'cleared' });
	}

	private post(msg: unknown): void {
		this.view?.webview.postMessage(msg);
		const m = msg as ChatEvent;
		if (m.type === 'turnEnd' || m.type === 'toolStart') {
			this.chats.closeAnswer();
		}
		if (m.type === 'card') {
			// transient prompts (setup, slow worker) are live-only; errors are kept without their buttons
			if (!m.id) {
				this.chats.record({ ...m, actions: undefined }, this.model);
			}
		} else {
			this.chats.record(m, this.model);
		}
	}

	/** Show the saved chat (after a reload, or when picked from History). */
	private replay(): void {
		const chat = this.chats.current();
		if (!chat) {
			return;
		}
		for (const e of chat.events) {
			this.view?.webview.postMessage(e);
		}
		this.view?.webview.postMessage({ type: 'turnEnd' });
		this.recap = ChatStore.summary(chat);
		this.agent = undefined; // a new worker session; the recap carries the context
	}

	private async onMessage(msg: any): Promise<void> {
		switch (msg?.type) {
			case 'command':
				if (typeof msg.command === 'string' && msg.command.startsWith('lightchain.')) {
					vscode.commands.executeCommand(msg.command);
				}
				return;
			case 'send': {
				const c = msg.ctx ?? {};
				return this.send(String(msg.text ?? ''), false, {
					file: typeof c.file === 'string' ? c.file : undefined,
					selection: c.selection && typeof c.selection.start === 'number' ? c.selection : undefined,
					mentions: Array.isArray(c.mentions) ? c.mentions.filter((m: unknown) => typeof m === 'string').slice(0, 8) : [],
				});
			}
			case 'reclaimStuck': {
				const account = this.wallet.active;
				if (!account) {
					return;
				}
				const net = this.network.current;
				try {
					const { claimable } = await this.stuck.summary(net, account);
					const n = await this.stuck.reclaim(net, account, claimable);
					this.post({ type: 'info', text: `Reclaimed the fees of ${n} stalled job${n === 1 ? '' : 's'} — they are back in your credits.` });
				} catch (err) {
					this.post({ type: 'error', message: friendlyError(err, account) });
				}
				return this.postState();
			}
			case 'faucet':
				return this.claimFaucet();
			case 'undoTurn':
				return this.undoTurn(String(msg.id));
			case 'files':
				this.post({ type: 'files', files: await mentionableFiles() });
				return;
			case 'enableCredits':
				return this.enableCredits();
			case 'retryWith': {
				// slow worker: re-send the same prompt on another model (new session)
				const text = this.inFlight?.text ?? this.retryText;
				this.retryText = undefined;
				if (typeof msg.name !== 'string' || !text) {
					return;
				}
				this.abort?.abort();
				await this.until(() => !this.abort);
				this.model = msg.name;
				await this.memento.update('lightchain.ai.model', msg.name);
				this.agent = undefined;
				this.post({ type: 'models', models: this.models, selected: this.model });
				this.post({ type: 'notice', message: `Re-sending your prompt to ${msg.name}.` });
				return this.send(text, true);
			}
			case 'keepWaiting':
				return;
			case 'retry': {
				const text = this.retryText;
				this.retryText = undefined;
				return text ? this.send(text, true) : undefined;
			}
			case 'stop':
				this.abort?.abort();
				return;
			case 'new':
				this.resetChat();
				return;
			case 'ready':
				return this.replay();
			case 'history':
				this.post({ type: 'historyList', chats: this.chats.all().map(c => ({ id: c.id, title: c.title, updated: c.updated, current: c.id === this.chats.current()?.id })) });
				return;
			case 'openChat': {
				if (typeof msg.id !== 'string' || this.abort) {
					return;
				}
				await this.chats.open(msg.id);
				this.view?.webview.postMessage({ type: 'cleared' });
				return this.replay();
			}
			case 'deleteChat':
				if (typeof msg.id === 'string') {
					const wasCurrent = this.chats.current()?.id === msg.id;
					await this.chats.remove(msg.id);
					if (wasCurrent) {
						this.resetChat();
					}
					this.post({ type: 'historyList', chats: this.chats.all().map(c => ({ id: c.id, title: c.title, updated: c.updated, current: c.id === this.chats.current()?.id })) });
				}
				return;
			case 'model':
				if (typeof msg.name === 'string' && msg.name !== this.model) {
					this.model = msg.name;
					await this.memento.update('lightchain.ai.model', msg.name);
					this.resetChat(); // a Lightchain session is bound to one model
					this.post({ type: 'models', models: this.models, selected: this.model });
					this.post({ type: 'notice', message: `Model: ${msg.name}. New chat started.` });
				}
				return;
			case 'approve': {
				const a = this.approvals.get(msg.id);
				if (a) {
					this.approvals.delete(msg.id);
					const declined: number[] = Array.isArray(msg.declined) ? msg.declined.filter((n: unknown) => typeof n === 'number') : [];
					const total = a.req.diff ? lineDiff(a.req.diff.before ?? '', a.req.diff.after).hunks : 0;
					if (!msg.ok || (total && declined.length >= total)) {
						a.resolve(false);
					} else if (declined.length && a.req.diff) {
						a.resolve({
							content: applyHunks(a.req.diff.before ?? '', a.req.diff.after, declined),
							note: `The user kept ${total - declined.length} of ${total} proposed changes and declined change(s) ${declined.map(n => n + 1).join(', ')}; the file now contains only the kept changes. Do not re-add the declined ones unless asked.`,
						});
					} else {
						a.resolve(true);
					}
				}
				return;
			}
			case 'viewDiff': {
				const a = this.approvals.get(msg.id);
				const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (a?.req.diff && root) {
					await this.proposals.showDiff(root, a.req.diff.path, a.req.diff.before, a.req.diff.after);
				}
				return;
			}
		}
	}

	private async send(request: string, retry = false, ctx?: PromptContext): Promise<void> {
		if (!request.trim() || this.abort) {
			return;
		}
		if (!retry) {
			this.autoRetried = false;
			void this.memento.update('lightchain.ai.asked', true);
		}
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			this.post({ type: 'error', message: 'Open a project folder to use Lightchain AI.' });
			return;
		}
		if (!vscode.workspace.isTrusted) {
			this.post({ type: 'error', message: 'Trust this folder to let Lightchain AI read and edit files.' });
			return;
		}
		if (!this.model) {
			this.post({ type: 'error', message: 'No Lightchain model is available right now. Try again in a moment.' });
			return;
		}
		// Don't submit a prompt the credits can't pay for: it would only fail after sign-in and upload.
		if (!retry && this.lastCredits !== undefined && this.lastCredits < JOB_FEE_LCAI) {
			this.post({ type: 'restoreInput', text: request });
			this.post({
				type: 'card', title: 'Not enough credits for a prompt', state: '', stateKind: 'err',
				detail: `Each Lightchain AI job costs about ${JOB_FEE_LCAI} LCAI in credits; you have ${this.lastCredits.toFixed(2)}. Top up, then send again.`,
				actions: [{ label: 'Top up credits', command: 'lightchain.credits.topUp' }],
			});
			return;
		}
		// Attach the project context (open file, selection, @-mentions, problems) to the prompt.
		let text = ctx ? (await buildContext(ctx)) + request : request;
		if (this.recap && !this.agent) {
			text = `Earlier in this conversation (recap — you are continuing it):\n${this.recap}\n\n---\n\n${text}`;
			this.recap = undefined;
		}
		this.agent ??= new Agent(this.provider(this.model), {
			root: fs.realpathSync(root),
			forgePath: findForge(),
			approve: req => this.requestApproval(req),
			onWrite: (file, before, after) => {
				const turn = this.currentTurn && this.checkpoints.get(this.currentTurn);
				if (turn) {
					const prev = turn.get(file);
					turn.set(file, { before: prev ? prev.before : before, after }); // keep the earliest "before"
				}
			},
		});
		this.abort = new AbortController();
		if (!retry) {
			const chips = ctx ? [...(ctx.file ? [ctx.selection ? `${basename(ctx.file)} · L${ctx.selection.start}–${ctx.selection.end}` : basename(ctx.file)] : []), ...ctx.mentions.map(basename)] : [];
			this.post({ type: 'user', text: request, chips });
		}
		this.post({ type: 'busy', busy: true });
		this.post({ type: 'status', text: 'Starting…' });
		this.inFlight = { text };
		let autoRetry: { text: string; model: string } | undefined;
		const turnId = `t${++this.seq}`;
		this.currentTurn = turnId;
		this.checkpoints.set(turnId, new Map());
		const clearSlow = () => { clearTimeout(this.slowTimer); this.slowTimer = undefined; this.post({ type: 'cardRemove', id: 'slow' }); };
		try {
			await this.agent.run(text, {
				onText: delta => { clearSlow(); this.post({ type: 'delta', text: delta }); },
				onToolStart: call => this.post({ type: 'toolStart', name: call.name, summary: summarize(call.name, call.args) }),
				onToolEnd: (call, result, soft) => soft
					? this.post({ type: 'status', text: 'Lightchain AI is adjusting its approach…' })
					: this.post({ type: 'toolEnd', name: call.name, ok: result.ok, output: result.output.slice(0, 600) }),
				onTurnEnd: () => this.post({ type: 'turnEnd' }),
				onStatus: (status, o) => {
					this.post({ type: 'status', text: status, walletPrompt: !!o?.walletPrompt });
					const job = /^Job (\d+) submitted/.exec(status)?.[1];
					if (job && this.inFlight) {
						this.inFlight.job = job;
						clearTimeout(this.slowTimer);
						this.slowTimer = setTimeout(() => this.suggestOtherModels(job), SLOW_AFTER_MS);
					}
				},
			}, this.abort.signal);
		} catch (err) {
			if (err instanceof WorkerError && err.jobId && this.wallet.active) {
				this.stuck.remember(err.jobId, this.network.current, this.wallet.active); // its fee can be reclaimed later
			}
			if (this.abort.signal.aborted) {
				// stopped by the user
			} else if (err instanceof DelegateNotAuthorizedError && err.delegate) {
				// Not an error from the user's point of view: a one-time setup step.
				// Their prompt is kept and sent again as soon as it's done.
				this.pendingDelegate = err.delegate as `0x${string}`;
				this.retryText = text;
				this.post({
					type: 'card', id: 'setup-credits', title: 'Allow Lightchain AI to use your credits', state: 'One-time setup', stateKind: 'wait',
					detail: `A single on-chain approval on ${this.network.current.label}${this.wallet.active?.kind === 'browser' ? ', confirmed in your browser wallet' : ''}. Your message is sent automatically right after.`,
					actions: [{ label: 'Allow', command: 'enableCredits' }],
				});
			} else if (err instanceof AgentStuckError) {
				this.retryText = text;
				const others = this.otherModels();
				this.post({
					type: 'card', title: `${this.model} couldn't complete the change`, state: 'Stopped', stateKind: 'err',
					detail: `${err.message} Try rephrasing the request more specifically${others.length ? ', or send it to another model' : ''}.`,
					actions: [...others.map((m, i) => ({ label: `Try ${m.name}`, command: 'retryWith', arg: m.name, ghost: i > 0 })), { label: 'Try again', command: 'retry', ghost: true }],
				});
			} else if (err instanceof SubmitError) {
				this.retryText = text;
				this.post({ type: 'card', title: err.message, state: 'Failed', stateKind: 'err', actions: [{ label: 'Try again', command: 'retry' }] });
			} else if (err instanceof WorkerError && !this.autoRetried) {
				// Recover without asking: another model with free workers, else a fresh session
				// on the same model (sortition usually picks a different worker).
				this.autoRetried = true;
				const next = this.otherModels()[0]?.name ?? this.model;
				autoRetry = { text, model: next! };
				this.post({ type: 'info', text: next === this.model ? 'The worker stopped responding — retried on a new worker.' : `The worker stopped responding — retried with ${next}.` });
			} else if (err instanceof WorkerError) {
				// a worker failure, not the user's: offer the same prompt on another model
				this.retryText = text;
				const others = this.otherModels();
				this.post({
					type: 'card', title: err.message, state: 'Failed', stateKind: 'err',
					detail: others.length ? 'Send the same prompt to another model:' : 'Try again in a moment.',
					actions: [...others.map((m, i) => ({ label: `Try ${m.name}`, command: 'retryWith', arg: m.name, ghost: i > 0 })), { label: 'Try again', command: 'retry', ghost: true }],
				});
			} else if (err instanceof InsufficientCreditsError) {
				this.retryText = text;
				this.post({ type: 'card', title: 'Not enough credits', state: 'Top up needed', stateKind: 'wait', detail: err.message, actions: [{ label: 'Top up credits', command: 'lightchain.credits.topUp' }, { label: 'Send again', command: 'retry', ghost: true }] });
			} else {
				this.post({ type: 'card', title: friendlyError(err, this.wallet.active), state: 'Failed', stateKind: 'err', actions: [{ label: 'Try again', command: 'retry', ghost: true }] });
				this.retryText = text;
			}
		} finally {
			const changed = this.checkpoints.get(turnId);
			if (changed?.size) {
				const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
				this.post({ type: 'checkpoint', id: turnId, files: [...changed.keys()].map(f => path.relative(root, f)) });
			} else {
				this.checkpoints.delete(turnId);
			}
			clearSlow();
			this.inFlight = undefined;
			this.approvals.forEach(a => a.resolve(false));
			this.approvals.clear();
			this.abort = undefined;
			this.post({ type: 'busy', busy: false });
			this.postState();
		}
		if (autoRetry) {
			// a new session: the failed one is bound to the stalled worker
			this.model = autoRetry.model;
			this.agent = undefined;
			this.post({ type: 'models', models: this.models, selected: this.model });
			await this.send(autoRetry.text, true);
		}
	}

	/** No answer yet: workers sometimes accept a job and stall. Offer models with free workers. */
	private suggestOtherModels(job: string): void {
		const others = this.otherModels();
		this.post({
			type: 'card', id: 'slow', title: 'This is taking longer than usual', state: '', stateKind: 'info',
			detail: `${this.model} accepted job ${job} but hasn't started answering. Workers sometimes stall; ${others.length ? 'you can send the same prompt to another model' : 'you can stop and try again in a moment'}.`,
			actions: [...others.map((m, i) => ({ label: `Try ${m.name}`, command: 'retryWith', arg: m.name, ghost: i > 0 })), { label: 'Keep waiting', command: 'keepWaiting', ghost: true, dismiss: true }],
		});
	}

	/** ⌘I: rewrite the selection (or the current line) in place from an instruction; Keep or Undo after. */
	async inlineEdit(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		if (!this.wallet.active) {
			vscode.window.showWarningMessage('Connect a wallet to use Lightchain AI.', 'Connect Wallet').then(p => p && vscode.commands.executeCommand('lightchain.wallet.menu'));
			return;
		}
		if (this.lastCredits !== undefined && this.lastCredits < JOB_FEE_LCAI) {
			vscode.window.showWarningMessage(`Not enough Lightchain AI credits (each request costs about ${JOB_FEE_LCAI} LCAI).`, 'Top Up').then(p => p && vscode.commands.executeCommand('lightchain.credits.topUp'));
			return;
		}
		if (!this.model) {
			await this.refreshModels();
		}
		const model = this.model;
		if (!model) {
			vscode.window.showWarningMessage('No Lightchain model is available right now.');
			return;
		}
		const doc = editor.document;
		const sel = editor.selection;
		const startLine = sel.start.line;
		const endLine = sel.isEmpty ? sel.start.line : (sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line);
		const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
		const instruction = await vscode.window.showInputBox({
			title: `Edit with Lightchain AI · ${model}`,
			prompt: `${startLine === endLine ? `Line ${startLine + 1}` : `Lines ${startLine + 1}–${endLine + 1}`} of ${vscode.workspace.asRelativePath(doc.uri, false)}`,
			placeHolder: 'Describe the change, e.g. add a require that msg.value > 0',
			ignoreFocusOut: true,
		});
		if (!instruction?.trim()) {
			return;
		}
		const original = doc.getText(range);
		const version = doc.version;
		let replacement: string | undefined;
		try {
			replacement = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Lightchain AI · ${model}`, cancellable: true }, async (progress, token) => {
				const ac = new AbortController();
				token.onCancellationRequested(() => ac.abort());
				return runInlineEdit(this.provider(model), {
					file: vscode.workspace.asRelativePath(doc.uri, false), language: doc.languageId, text: doc.getText(),
					startLine: startLine + 1, endLine: endLine + 1, instruction: instruction.trim(),
				}, ac.signal, status => progress.report({ message: status }));
			});
		} catch (err) {
			vscode.window.showErrorMessage(err instanceof WorkerError || err instanceof SubmitError ? `${err.message} Try again.` : friendlyError(err, this.wallet.active));
			return;
		} finally {
			this.postState();
		}
		if (!replacement || replacement === original) {
			vscode.window.showInformationMessage('Lightchain AI suggested no change.');
			return;
		}
		if (doc.version !== version) {
			vscode.window.showWarningMessage('The file changed while Lightchain AI was working, so the edit was not applied.');
			return;
		}
		await editor.edit(b => b.replace(range, replacement!));
		const newEnd = startLine + replacement.split('\n').length - 1;
		const changed = new vscode.Range(startLine, 0, newEnd, doc.lineAt(Math.min(newEnd, doc.lineCount - 1)).text.length);
		const highlight = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(62, 183, 94, 0.12)', isWholeLine: true });
		editor.setDecorations(highlight, [changed]);
		const choice = await vscode.window.showInformationMessage(`Lightchain AI edited lines ${startLine + 1}–${newEnd + 1}.`, 'Keep', 'Undo');
		highlight.dispose();
		if (choice === 'Undo' && doc.getText(changed) === replacement) {
			await editor.edit(b => b.replace(changed, original));
		}
	}

	/** Open the panel and send a prompt about a file range (used by the lightbulb quick fix). */
	async fixProblems(uri: vscode.Uri, problems: { line: number; endLine: number; message: string }[]): Promise<void> {
		await vscode.commands.executeCommand('lightchain.ai.focus');
		const file = vscode.workspace.asRelativePath(uri, false);
		const start = Math.max(1, Math.min(...problems.map(p => p.line)) - 3);
		const end = Math.max(...problems.map(p => p.endLine)) + 3;
		const list = problems.map(p => `- line ${p.line}: ${p.message}`).join('\n');
		await this.send(`Fix ${problems.length === 1 ? 'this problem' : 'these problems'} in ${file}:\n${list}`, false, { file, selection: { start, end }, mentions: [] });
	}

	/** Open the panel with the selection attached and the cursor in the composer (nothing sent). */
	async askAboutSelection(): Promise<void> {
		await vscode.commands.executeCommand('lightchain.ai.focus');
		this.post({ type: 'context', ...editorContext() });
		this.post({ type: 'focusInput' });
	}

	/** Testnet only: claim LCAI from the Lightchain faucet (2 LCAI per 24 h, no captcha). */
	private async claimFaucet(): Promise<void> {
		const account = this.wallet.active;
		if (!account || this.network.current.id !== 'testnet') {
			return;
		}
		this.post({ type: 'faucetState', busy: true });
		let message: string;
		let ok = false;
		try {
			const res = await fetch('https://lightfaucet.ai/api/claim', {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ address: account.address, network: 'testnet' }),
				signal: AbortSignal.timeout(60_000),
			});
			const body = await res.json().catch(() => ({})) as { message?: string };
			ok = res.ok;
			message = (body.message ?? (ok ? 'Testnet LCAI sent.' : `Faucet error (${res.status}).`)).replace(/^([^:]+):\s*/, '$1 — ');
		} catch {
			message = 'The faucet is unreachable right now. Try lightfaucet.ai in your browser.';
		}
		this.post({ type: 'faucetState', busy: false, ok, message });
		if (ok) {
			// the transfer needs a block or two
			setTimeout(() => this.postState(), 6_000);
			setTimeout(() => this.postState(), 15_000);
		}
	}

	/** Restore every file the agent wrote in one turn to its state before the turn. */
	private async undoTurn(id: string): Promise<void> {
		const turn = this.checkpoints.get(id);
		if (!turn) {
			return;
		}
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
		const current = async (f: string) => {
			const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === f);
			return open ? open.getText() : fs.promises.readFile(f, 'utf8').catch(() => undefined);
		};
		const edited: string[] = [];
		for (const [f, v] of turn) {
			if ((await current(f)) !== v.after) {
				edited.push(path.relative(root, f));
			}
		}
		if (edited.length) {
			const ok = await vscode.window.showWarningMessage(
				`${edited.join(', ')} changed after Lightchain AI wrote ${edited.length === 1 ? 'it' : 'them'}.`,
				{ modal: true, detail: 'Undo restores the version from before this turn and discards those later edits.' },
				'Undo Anyway');
			if (ok !== 'Undo Anyway') {
				return;
			}
		}
		for (const [f, v] of turn) {
			const uri = vscode.Uri.file(f);
			if (v.before === undefined) {
				await vscode.workspace.fs.delete(uri, { useTrash: true }).then(undefined, () => undefined);
			} else {
				await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(v.before));
			}
		}
		this.checkpoints.delete(id);
		this.post({ type: 'checkpointUndone', id });
	}

	/** Up to three other chat models with free workers right now. */
	private otherModels(): LightchainModel[] {
		return this.models.filter(m => m.available && m.name !== this.model && (m.freeSlots ?? 1) > 0).slice(0, 3);
	}

	private until(cond: () => boolean): Promise<void> {
		return new Promise(resolve => { const t = setInterval(() => { if (cond()) { clearInterval(t); resolve(); } }, 50); });
	}

	private async enableCredits(): Promise<void> {
		const account = this.wallet.active;
		if (!account || !this.pendingDelegate) {
			return;
		}
		const net = this.network.current;
		const update = (state: string, stateKind: string, detail: string, actions: unknown[] = []) =>
			this.post({ type: 'cardUpdate', id: 'setup-credits', state, stateKind, detail, actions });
		try {
			const gas = await this.wallet.publicClient(net).getBalance({ address: account.address });
			if (gas === 0n) {
				update('Needs LCAI', 'err', friendlyError(new Error('insufficient funds'), account), [{ label: 'Allow', command: 'enableCredits' }]);
				return;
			}
			update('Waiting for approval', 'wait', account.kind === 'browser' ? 'Approve the transaction in your browser wallet.' : 'Sending the approval…');
			await this.credits.enableForAi(account, net, this.pendingDelegate);
			this.pendingDelegate = undefined;
			update('Done', 'ok', 'Credits enabled. Sending your message…');
			const text = this.retryText;
			this.retryText = undefined;
			if (text) {
				await this.send(text, true);
			}
		} catch (err) {
			update('Failed', 'err', friendlyError(err, account), [{ label: 'Try again', command: 'enableCredits' }]);
		}
	}

	private requestApproval(req: ApprovalRequest): Promise<boolean | PartialApproval> {
		const id = `a${++this.seq}`;
		return new Promise(resolve => {
			this.approvals.set(id, { resolve, req });
			const diff = req.diff ? lineDiff(req.diff.before ?? '', req.diff.after) : undefined;
			this.post({ type: 'approval', id, kind: req.kind, title: req.title, detail: req.detail, path: req.diff?.path, diff, isNew: req.diff ? !req.diff.before : undefined });
		});
	}

	private async postState(): Promise<void> {
		const gen = ++this.generation;
		const account = this.wallet.active;
		const network = this.network.current;
		const base = {
			type: 'state', network: network.label, testnet: network.id === 'testnet',
			account: account ? shortAddress(account.address) : null, credits: null as string | null,
			gas: null as number | null, creditsNum: null as number | null,
			asked: this.memento.get<boolean>('lightchain.ai.asked', false),
		};
		this.post(base);
		if (account) {
			try {
				const snap = await this.credits.read(account, network);
				if (gen === this.generation) {
					this.lastCredits = Number(snap.credits) / 1e18;
					this.post({ ...base, credits: formatLcai(snap.credits), gas: Number(snap.walletBalance) / 1e18, creditsNum: this.lastCredits });
				}
				const stuck = await this.stuck.summary(network, account);
				if (gen === this.generation) {
					this.post({ type: 'reclaim', count: stuck.claimable.length, fee: formatLcai(stuck.fee) });
				}
			} catch { /* RPC unreachable */ }
		}
	}

	private html(webview: vscode.Webview): string {
		const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
	@font-face { font-family: "Inter"; src: url("${media('Inter-latin.woff2')}") format("woff2"); font-weight: 100 900; unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
	@font-face { font-family: "Inter"; src: url("${media('Inter-latin-ext.woff2')}") format("woff2"); font-weight: 100 900; unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }
	body { margin: 0; font-family: "Inter", sans-serif; font-size: 16px; line-height: 1.6; color: #7376aa; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
	*, *::before, *::after { box-sizing: border-box; }
	p { margin: 0; }
	/* site base 16px -> IDE 13px (13/16) */
	.lc-top, .lc-thread, .lc-form { zoom: 0.8125; }

	/* .lc-sm-title.border-left eyebrow + credits */
	.lc-top { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
	.lc-sm-title { margin: 0; padding-left: 10px; border-left: 3px solid #dd00ac; color: #b1b3d0; font-size: 16px; font-weight: 500; line-height: 19.2px; letter-spacing: -0.096px; text-transform: uppercase; white-space: nowrap; }
	.lc-top__credits { color: #f5f6ff; font-size: 14px; white-space: nowrap; cursor: pointer; }
	.lc-top__credits span { color: #b1b3d0; }
	.lc-top__right { display: flex; align-items: center; gap: 16px; }
	/* model picker = lcai-chat-v2 components/model-picker.tsx (ModelSelect) + ui/dropdown-menu, dark tokens */
	.lc-model { position: relative; flex: 1; min-width: 0; }
	.lc-model__trigger { display: inline-flex; align-items: center; gap: 8px; height: 32px; max-width: 100%; padding: 0 6px; border: 0; border-radius: 12px; background: transparent; color: #9798B6; font-family: "Inter", sans-serif; font-size: 12px; line-height: 16px; font-weight: 500; cursor: pointer; transition: background-color .15s; }
	.lc-model__trigger:hover, .lc-model__trigger[aria-expanded="true"] { background: rgba(204, 206, 239, 0.04); }
	.lc-model__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.lc-chev { flex: none; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
	.lc-dot { flex: none; display: inline-block; width: 6px; height: 6px; border-radius: 9999px; }
	.lc-dot.ok { background: oklch(69.6% 0.17 162.48); } .lc-dot.busy { background: oklch(76.9% 0.188 70.08); } .lc-dot.off { background: oklch(63.7% 0.237 25.331); }
	.lc-logo { flex: none; width: 14px; height: 14px; }
	.lc-model__menu { position: absolute; left: 0; bottom: calc(100% + 4px); z-index: 50; min-width: 240px; max-width: 300px; max-height: 340px; overflow-y: auto; overflow-x: hidden; padding: 6px; border: 1px solid rgba(204, 206, 239, 0.06); border-radius: 12px; background: #0F0F14; color: #CCCEEF; box-shadow: 0 8px 24px -6px rgba(12, 12, 13, 0.08), 0 4px 4px -4px rgba(12, 12, 13, 0.05); }
	.lc-model__menu[hidden] { display: none; }
	.lc-model__label { padding: 4px 8px; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.08em; color: #CCCEEF; }
	.lc-model__item { position: relative; display: flex; align-items: center; width: 100%; padding: 6px 8px 6px 32px; border: 0; border-radius: 8px; background: transparent; color: #CCCEEF; font-family: "Inter", sans-serif; font-size: 14px; text-align: left; cursor: pointer; outline: none; transition: background-color .15s; }
	.lc-model__item:hover, .lc-model__item:focus { background: hsl(240 3.7% 15.9%); }
	.lc-model__item:disabled { opacity: .45; cursor: default; background: transparent; }
	.lc-model__check { position: absolute; left: 8px; display: flex; width: 14px; height: 14px; align-items: center; justify-content: center; }
	.lc-model__check::after { content: ""; width: 8px; height: 8px; border-radius: 9999px; background: currentColor; }
	.lc-model__row { display: flex; width: 100%; min-width: 0; align-items: center; justify-content: space-between; gap: 8px; }
	.lc-model__left { display: flex; min-width: 0; align-items: center; gap: 6px; }
	.lc-model__left .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; }
	.lc-model__count { margin-left: auto; flex: none; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 10px; }
	.lc-model__count.off { color: oklch(63.7% 0.237 25.331); } .lc-model__count.busy { color: oklch(76.9% 0.188 70.08); }
	.lc-top { position: relative; }
	.lc-history { position: absolute; right: 16px; top: calc(100% + 4px); z-index: 70; width: 300px; max-height: 360px; overflow-y: auto; padding: 6px; border: 1px solid rgba(204, 206, 239, 0.06); border-radius: 12px; background: #0F0F14; }
	.lc-history[hidden] { display: none; }
	.lc-history__label { padding: 4px 8px; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.08em; color: #CCCEEF; }
	.lc-history__item { display: flex; align-items: center; gap: 6px; border-radius: 8px; }
	.lc-history__item:hover, .lc-history__item.current { background: hsl(240 3.7% 15.9%); }
	.lc-history__item button.open { flex: 1; min-width: 0; padding: 6px 8px; border: 0; background: transparent; color: #CCCEEF; font-family: "Inter", sans-serif; font-size: 13px; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.lc-history__item small { flex: none; color: #7376aa; font-size: 11px; }
	.lc-history__item button.del { flex: none; width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent; color: #7376aa; cursor: pointer; }
	.lc-history__item button.del:hover { color: #f5f6ff; background: rgba(204, 206, 239, 0.1); }
	.lc-history__empty { padding: 6px 8px; color: #7376aa; font-size: 13px; }
	.lc-top__right .lc-link + .lc-link { margin-left: 2px; }
	.lc-link { background: none; border: 0; color: #b1b3d0; font: inherit; font-size: 14px; cursor: pointer; padding: 0; }

	.lc-banner { flex: none; zoom: 0.8125; display: flex; align-items: center; gap: 8px; margin: 10px 16px 0; padding: 8px 8px 8px 12px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px; background: #020203; color: #b1b3d0; font-size: 13px; }
	.lc-banner[hidden] { display: none; }
	.lc-banner span { flex: 1; min-width: 0; }
	.lc-thread { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
	.lc-empty { margin: auto 0; text-align: left; }
	.lc-empty img { width: 176px; height: auto; display: block; margin-bottom: 16px; }
	.lc-empty p { color: #b1b3d0; font-size: 14px; }
	/* first-run checklist */
	.lc-setup { margin-top: 20px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px; background: #020203; overflow: hidden; }
	.lc-setup[hidden] { display: none; }
	.lc-setup__title { padding: 10px 12px 6px; color: #f5f6ff; font-size: 13px; font-weight: 500; }
	.lc-setup__row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-top: 1px solid rgba(255, 255, 255, 0.06); font-size: 13px; color: #b1b3d0; }
	.lc-setup__n { flex: none; width: 18px; height: 18px; border-radius: 50%; border: 1px solid rgba(204, 206, 239, 0.25); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; color: #7376aa; }
	.lc-setup__row.done { color: #7376aa; }
	.lc-setup__row.done .lc-setup__n { border-color: #3eb75e; color: #3eb75e; }
	.lc-setup__row .t { flex: 1; min-width: 0; }
	.lc-setup__row .t small { display: block; color: #7376aa; font-size: 11px; }
	/* Chat layout in the style of Cursor / Claude, with lightchain.ai colours and type */
	.lc-thread > * { flex: none; } /* never squash blocks; the thread scrolls instead */
	.lc-msg-user { align-self: stretch; padding: 10px 14px; background: rgba(204, 206, 239, 0.06); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 10px; color: #f5f6ff; font-size: 15px; white-space: pre-wrap; word-break: break-word; }
	.lc-msg-ai { color: #ccceef; font-size: 15px; word-break: break-word; }
	.lc-msg-ai pre { margin: 8px 0; padding: 10px 12px; background: #020203; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; overflow-x: auto; font-family: Menlo, Monaco, "Courier New", monospace; font-size: 13px; line-height: 1.5; color: #ccceef; white-space: pre; }
	.lc-msg-ai code { font-family: Menlo, Monaco, "Courier New", monospace; font-size: 0.88em; color: #f5f6ff; background: rgba(204, 206, 239, 0.08); padding: 1px 4px; border-radius: 4px; }
	.lc-msg-ai pre code { background: none; padding: 0; }

	/* tool steps: one quiet line each, click to expand output */
	.lc-step { display: flex; flex-direction: column; gap: 4px; }
	.lc-step__row { display: flex; align-items: center; gap: 8px; color: #7376aa; font-size: 13px; cursor: default; user-select: none; }
	.lc-step.has-out .lc-step__row { cursor: pointer; }
	.lc-step.has-out .lc-step__row:hover { color: #b1b3d0; }
	.lc-step__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.lc-step__label b { color: #b1b3d0; font-weight: 500; }
	.lc-checkpoint { display: flex; align-items: center; gap: 8px; color: #7376aa; font-size: 12px; }
	.lc-checkpoint .files { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.lc-checkpoint.undone .files { text-decoration: line-through; }
	.lc-step__why { flex: none; color: #7376aa; font-size: 12px; white-space: nowrap; }
	.lc-ico { flex: none; width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; }
	.lc-ico svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
	.lc-ico.ok { color: #3eb75e; } .lc-ico.err { color: #ff2a27; }
	.lc-spin { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid rgba(204, 206, 239, 0.25); border-top-color: #dd00ac; animation: spin .8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	.lc-step__out { margin: 0 0 0 22px; padding: 8px 10px; background: #020203; border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 6px; color: #7376aa; font-family: Menlo, Monaco, "Courier New", monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow: auto; }

	/* file edit / command proposal: inline block with diff and small actions */
	.lc-edit { border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px; background: #020203; overflow: hidden; }
	.lc-edit__head { display: flex; align-items: center; gap: 8px; padding: 7px 8px 7px 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); font-size: 13px; }
	.lc-edit__path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #f5f6ff; font-family: Menlo, Monaco, "Courier New", monospace; font-size: 12px; cursor: pointer; }
	.lc-edit__path:hover { text-decoration: underline; }
	.lc-edit__stat { flex: none; font-family: Menlo, Monaco, "Courier New", monospace; font-size: 12px; }
	.lc-edit__stat .a { color: #3eb75e; } .lc-edit__stat .r { color: #ff2a27; margin-left: 4px; }
	.lc-edit__actions { margin-left: auto; display: flex; align-items: center; gap: 4px; flex: none; }
	.lc-edit__state { margin-left: auto; flex: none; font-size: 12px; color: #7376aa; }
	.lc-edit__state.ok { color: #3eb75e; } .lc-edit__state.err { color: #ff2a27; }
	.lc-diff { max-height: 240px; overflow: auto; font-family: Menlo, Monaco, "Courier New", monospace; font-size: 12px; line-height: 18px; }
	.lc-diff div { padding: 0 12px; white-space: pre; color: #7376aa; min-width: max-content; }
	.lc-diff .add { background: rgba(62, 183, 94, 0.10); color: #ccceef; }
	.lc-diff .add::before { content: "+ "; color: #3eb75e; }
	.lc-diff .del { background: rgba(255, 42, 39, 0.10); color: #b1b3d0; text-decoration: line-through; text-decoration-color: rgba(255, 42, 39, 0.4); }
	.lc-diff .del::before { content: "- "; color: #ff2a27; }
	.lc-diff .ctx::before { content: "  "; }
	.lc-diff .gap { color: #7376aa; opacity: .6; text-align: center; }
	.lc-edit.done .lc-diff { display: none; }
	.lc-diff .lc-hunk { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 6px 2px 12px; background: rgba(204, 206, 239, 0.04); color: #7376aa; font-family: "Inter", sans-serif; font-size: 11px; white-space: normal; min-width: 0; }
	.lc-diff .lc-hunk::before { content: none; }
	.lc-hunk__toggle { height: 20px; padding: 0 8px; border: 1px solid rgba(62, 183, 94, 0.4); border-radius: 5px; background: transparent; color: #3eb75e; font-size: 11px; cursor: pointer; }
	.lc-hunk__toggle.off { border-color: rgba(255, 255, 255, 0.15); color: #7376aa; }
	.lc-diff .declined { opacity: .35; }
	.lc-edit__cmd { padding: 10px 12px; font-family: Menlo, Monaco, "Courier New", monospace; font-size: 12px; color: #ccceef; white-space: pre-wrap; word-break: break-all; }

	/* small inline actions (not page buttons) */
	.lc-btn { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: #b1b3d0; font-family: "Inter", sans-serif; font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap; }
	.lc-btn:hover { background: rgba(204, 206, 239, 0.08); color: #f5f6ff; }
	.lc-btn.primary { background: linear-gradient(90deg, #df04ae 0%, #412ffd 100%); color: #fff; }
	.lc-btn.primary:hover { filter: brightness(1.1); }
	.lc-btn:disabled { opacity: .5; cursor: default; }
	.lc-kbd { font-size: 11px; opacity: .75; }

	/* notes (setup steps, errors) */
	.lc-note { padding: 10px 12px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px; background: #020203; font-size: 13px; }
	.lc-note__head { display: flex; align-items: flex-start; gap: 8px; color: #f5f6ff; font-weight: 500; }
	.lc-note__head .lc-ico { margin-top: 3px; }
	.lc-note__text { margin: 4px 0 0 22px; color: #b1b3d0; line-height: 1.5; }
	.lc-note__actions { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0 0 16px; }

	/* composer: one box, model picker and round send button inside */
	.lc-form { flex: none; padding: 8px 12px 12px; }
	.lc-composer { position: relative; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; background: #020203; transition: border-color .15s; }
	/* context chips (current file, selection, @-mentions) */
	.lc-chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 10px 0; }
	.lc-chips:empty { display: none; }
	.lc-chip { display: inline-flex; align-items: center; gap: 4px; height: 22px; max-width: 100%; padding: 0 4px 0 8px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 6px; background: rgba(204, 206, 239, 0.06); color: #b1b3d0; font-size: 12px; white-space: nowrap; }
	.lc-chip.off { opacity: .5; text-decoration: line-through; }
	.lc-chip span { overflow: hidden; text-overflow: ellipsis; }
	.lc-chip button { width: 16px; height: 16px; border: 0; border-radius: 4px; background: transparent; color: #7376aa; font-size: 12px; line-height: 16px; cursor: pointer; padding: 0; }
	.lc-chip button:hover { background: rgba(204, 206, 239, 0.1); color: #f5f6ff; }
	.lc-msg-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
	.lc-msg-chips span { padding: 1px 6px; border-radius: 4px; background: rgba(204, 206, 239, 0.08); color: #7376aa; font-size: 11px; }
	/* @-mention picker: same surface as the model menu */
	.lc-mention { position: absolute; left: 8px; right: 8px; bottom: calc(100% + 4px); z-index: 60; max-height: 220px; overflow-y: auto; padding: 6px; border: 1px solid rgba(204, 206, 239, 0.06); border-radius: 12px; background: #0F0F14; }
	.lc-mention[hidden] { display: none; }
	.lc-mention button { display: block; width: 100%; padding: 5px 8px; border: 0; border-radius: 8px; background: transparent; color: #CCCEEF; font-family: Menlo, Monaco, "Courier New", monospace; font-size: 12px; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.lc-mention button.active, .lc-mention button:hover { background: hsl(240 3.7% 15.9%); }
	.lc-mention .empty { padding: 5px 8px; color: #7376aa; font-size: 12px; }
	.lc-composer:focus-within { border-color: rgba(255, 255, 255, 0.2); }
	textarea { display: block; width: 100%; max-height: 200px; padding: 10px 12px 4px; resize: none; background: transparent; border: 0; outline: none; color: #ccceef; font-family: "Inter", sans-serif; font-size: 15px; line-height: 22px; }
	textarea::placeholder { color: #7376aa; }
	.lc-form__row { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 6px 6px; }
	.lc-send { flex: none; width: 30px; height: 30px; border: 0; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: linear-gradient(90deg, #df04ae 0%, #412ffd 100%); color: #fff; cursor: pointer; }
	.lc-send svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
	.lc-send:disabled { background: rgba(204, 206, 239, 0.12); color: #7376aa; cursor: default; }
	.lc-send.stop { background: rgba(204, 206, 239, 0.14); color: #f5f6ff; }
	.lc-send.stop svg { fill: currentColor; stroke: none; width: 10px; height: 10px; }

	/* live progress */
	.lc-status { display: flex; align-items: center; gap: 8px; color: #7376aa; font-size: 13px; }
	.lc-status__text { background: linear-gradient(90deg, #7376aa 0%, #f5f6ff 50%, #7376aa 100%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: shimmer 2s linear infinite; }
	@keyframes shimmer { to { background-position: -200% 0; } }
	.cursor::after { content: "▍"; color: #dd00ac; animation: blink 1s steps(1) infinite; }
	@keyframes blink { 50% { opacity: 0; } }
</style>
</head>
<body>
	<div class="lc-top">
		<h4 class="lc-sm-title" id="eyebrow">Testnet</h4>
		<div class="lc-top__right"><div class="lc-top__credits" id="credits" title="Lightchain AI credits"></div><button class="lc-link" id="historyBtn">History</button><button class="lc-link" id="new">New chat</button></div>
		<div class="lc-history" id="history" hidden></div>
	</div>
	<div class="lc-banner" id="banner" hidden></div>
	<div class="lc-thread" id="thread">
		<div class="lc-empty" id="empty">
			<img src="${media('logo.svg')}" alt="Lightchain AI">
			<p>Ask Lightchain AI to write contracts, tests and scripts, explain code or fix build errors. It reads your project and proposes changes you approve.</p>
			<div class="lc-setup" id="setup" hidden></div>
		</div>
	</div>
	<div class="lc-form">
		<div class="lc-composer">
			<div class="lc-mention" id="mention" hidden></div>
			<div class="lc-chips" id="chips"></div>
			<textarea id="input" rows="2" placeholder="Ask Lightchain AI… type @ to add a file"></textarea>
			<div class="lc-form__row">
				<div class="lc-model" id="modelBox">
					<button class="lc-model__trigger" id="modelBtn" type="button" aria-haspopup="listbox" aria-expanded="false"><span class="lc-dot" id="modelDot"></span><span id="modelLogo"></span><span class="lc-model__name" id="modelLabel">Select model</span><svg class="lc-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
					<div class="lc-model__menu" id="modelMenu" role="listbox" hidden></div>
				</div>
				<button class="lc-send" id="send" title="Send (Enter)" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg></button>
			</div>
		</div>
	</div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const $ = id => document.getElementById(id);
	const thread = $('thread');
	let busy = false, current = null, currentText = '';

	const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
	function render(text) {
		// hide tool-call JSON (shown as tool cards), render fenced code + inline code + bold
		const visible = text.replace(/\`\`\`tool[\\s\\S]*?(\`\`\`|$)/g, '').trim();
		const parts = visible.split(/(\`\`\`[\\s\\S]*?(?:\`\`\`|$))/g);
		return parts.map(p => {
			if (p.startsWith('\`\`\`')) {
				const body = p.replace(/^\`\`\`[^\\n]*\\n?/, '').replace(/\`\`\`$/, '');
				return '<pre>' + esc(body) + '</pre>';
			}
			return esc(p).replace(/\`([^\`]+)\`/g, '<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>').replace(/\\n/g, '<br>');
		}).join('');
	}
	const scroll = () => { thread.scrollTop = thread.scrollHeight; };
	function add(el) { $('empty')?.remove(); thread.appendChild(el); scroll(); return el; }
	let statusEl = null;
	const ICONS = {
		ok: '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
		err: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
		info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>',
		stop: '<svg viewBox="0 0 10 10"><rect width="10" height="10" rx="2"/></svg>',
		send: '<svg viewBox="0 0 24 24"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
	};
	const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
	function ico(kind) { const i = el('span', 'lc-ico ' + kind); if (kind === 'wait') i.append(el('span', 'lc-spin')); else i.innerHTML = ICONS[kind] || ''; return i; }
	function smallBtn(label, primary, fn, kbd) { const b = el('button', 'lc-btn' + (primary ? ' primary' : ''), label); if (kbd) b.append(el('span', 'lc-kbd', kbd)); b.onclick = fn; return b; }
	function setStatus(text, walletPrompt) {
		if (!statusEl) { statusEl = add(el('div', 'lc-status')); }
		statusEl.replaceChildren(ico('wait'), el('span', 'lc-status__text', text));
		if (walletPrompt) statusEl.append(smallBtn('Open wallet page', false, () => vscode.postMessage({ type: 'command', command: 'lightchain.wallet.openPage' })));
		thread.appendChild(statusEl); scroll();
	}
	function clearStatus() { statusEl?.remove(); statusEl = null; }
	function aiBubble() { clearStatus(); if (!current) { current = add(el('div', 'lc-msg-ai cursor')); currentText = ''; } return current; }
	function closeBubble() { if (current) { current.classList.remove('cursor'); if (!current.textContent.trim()) current.remove(); } current = null; }

	// setup steps and errors: a quiet note with small actions
	const emptyState = document.getElementById('empty'); // kept to restore on New chat
	function card(m) {
		closeBubble(); clearStatus();
		const n = el('div', 'lc-note');
		if (m.id) { thread.querySelector('[data-card="' + m.id + '"]')?.remove(); n.dataset.card = m.id; }
		fillCard(n, m);
		return add(n);
	}
	function fillCard(n, m) {
		const kind = m.stateKind === 'ok' ? 'ok' : m.stateKind === 'err' ? 'err' : m.stateKind === 'wait' && m.state && /waiting|sending/i.test(m.state) ? 'wait' : 'info';
		const head = el('div', 'lc-note__head'); head.append(ico(kind), el('span', '', m.title || n.dataset.title || ''));
		if (m.title) n.dataset.title = m.title;
		n.replaceChildren(head);
		if (m.detail) n.append(el('div', 'lc-note__text', m.detail));
		if (m.actions && m.actions.length) {
			const actions = el('div', 'lc-note__actions');
			m.actions.forEach((a, i) => actions.append(smallBtn(a.label, !a.ghost && i === 0, () => {
				actions.querySelectorAll('button').forEach(x => x.disabled = true);
				if (a.dismiss) { n.remove(); return; }
				vscode.postMessage(a.command.startsWith('lightchain.') ? { type: 'command', command: a.command } : { type: a.command, name: a.arg });
			})));
			n.append(actions);
		}
		scroll();
	}
	// tool calls: one line each; output expands on click
	function toolCard(name, summary) {
		closeBubble();
		const step = el('div', 'lc-step');
		const row = el('div', 'lc-step__row');
		const label = el('span', 'lc-step__label');
		const m = /^(\S+)\s+(.*)$/.exec(summary || name);
		if (m) { label.append(document.createTextNode(m[1] + ' '), el('b', '', m[2])); } else { label.textContent = summary || name; }
		row.append(ico('wait'), label);
		step.append(row);
		row.onclick = () => { const o = step.querySelector('.lc-step__out'); if (o) o.hidden = !o.hidden; };
		return add(step);
	}
	let lastTool = null;
	let pending = null; // the approval waiting for Accept / Reject

	const input = $('input'), send = $('send');
	function syncSend() {
		send.className = 'lc-send' + (busy ? ' stop' : '');
		send.innerHTML = busy ? ICONS.stop : ICONS.send;
		send.title = busy ? 'Stop' : 'Send (Enter)';
		send.disabled = !busy && !input.value.trim();
	}
	function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; }
	function setBusy(b) { busy = b; syncSend(); }
	// ---- first-run checklist ----
	let lastState = null, faucet = {};
	function renderSetup() {
		const box = $('setup'); if (!box || !lastState) return;
		const s = lastState;
		const steps = [
			{ title: 'Connect a wallet', done: !!s.account, action: ['Connect', () => vscode.postMessage({ type: 'command', command: 'lightchain.wallet.menu' })] },
		];
		if (s.testnet) steps.push({ title: 'Get testnet LCAI', note: faucet.message || 'Free test tokens pay for gas — 2 LCAI per day', done: s.gas !== null && s.gas >= 0.05, action: s.account ? [faucet.busy ? 'Claiming…' : 'Claim', () => vscode.postMessage({ type: 'faucet' }), faucet.busy] : null });
		steps.push({ title: 'Add credits for Lightchain AI', note: 'Prompts are paid from credits on ' + s.network, done: s.creditsNum !== null && s.creditsNum >= 0.05, action: s.account ? ['Top up', () => vscode.postMessage({ type: 'command', command: 'lightchain.credits.topUp' })] : null });
		steps.push({ title: 'Ask your first question', done: !!s.asked, action: ['Start', () => input.focus()] });
		const allDone = steps.every(x => x.done);
		box.hidden = allDone;
		if (allDone) return;
		box.replaceChildren(el('div', 'lc-setup__title', 'Get started'));
		steps.forEach((x, i) => {
			const row = el('div', 'lc-setup__row' + (x.done ? ' done' : ''));
			const n = el('span', 'lc-setup__n', x.done ? '✓' : String(i + 1));
			const t = el('span', 't', x.title); if (x.note && !x.done) t.append(el('small', '', x.note));
			row.append(n, t);
			if (!x.done && x.action) { const b = smallBtn(x.action[0], i === steps.findIndex(y => !y.done), x.action[1]); if (x.action[2]) b.disabled = true; row.append(b); }
			box.append(row);
		});
	}

	// ---- context chips + @-mentions ----
	const ctx = { file: null, selection: null, fileOff: false, mentions: [] };
	const chipsEl = $('chips'), mentionEl = $('mention');
	let allFiles = null, mentionIdx = 0, mentionMatches = [];
	const base = p => p.split('/').pop();
	function renderChips() {
		chipsEl.replaceChildren();
		const chip = (label, title, onX, off) => {
			const c = el('span', 'lc-chip' + (off ? ' off' : '')); c.title = title;
			const t = el('span', '', label); const x = el('button', '', off ? '+' : '×'); x.title = off ? 'Include' : 'Remove'; x.onclick = onX;
			c.append(t, x); chipsEl.append(c);
		};
		if (ctx.file) {
			const label = ctx.selection && !ctx.fileOff ? base(ctx.file) + ' · L' + ctx.selection.start + '–' + ctx.selection.end : base(ctx.file);
			chip(label, ctx.fileOff ? ctx.file + ' (not included)' : ctx.file + ' — included with your prompt', () => { ctx.fileOff = !ctx.fileOff; renderChips(); }, ctx.fileOff);
		}
		ctx.mentions.forEach((m, i) => chip('@' + base(m), m, () => { ctx.mentions.splice(i, 1); renderChips(); }));
	}
	function mentionQuery() {
		const before = input.value.slice(0, input.selectionStart);
		const m = /(^|\\s)@([^\\s@]*)$/.exec(before);
		return m ? m[2] : null;
	}
	function showMentions() {
		const q = mentionQuery();
		if (q === null) { mentionEl.hidden = true; return; }
		if (!allFiles) { vscode.postMessage({ type: 'files' }); allFiles = []; }
		const ql = q.toLowerCase();
		mentionMatches = allFiles.filter(f => f.toLowerCase().includes(ql) && !ctx.mentions.includes(f)).slice(0, 12);
		mentionIdx = Math.min(mentionIdx, Math.max(0, mentionMatches.length - 1));
		mentionEl.replaceChildren(...(mentionMatches.length ? mentionMatches.map((f, i) => {
			const b = el('button', i === mentionIdx ? 'active' : '', f); b.type = 'button';
			b.onmousedown = e => { e.preventDefault(); pickMention(f); };
			return b;
		}) : [el('div', 'empty', allFiles.length ? 'No matching files' : 'Loading files…')]));
		mentionEl.hidden = false;
	}
	function pickMention(f) {
		const caret = input.selectionStart;
		const before = input.value.slice(0, caret).replace(/@[^\\s@]*$/, '');
		input.value = before + input.value.slice(caret);
		input.selectionStart = input.selectionEnd = before.length;
		if (!ctx.mentions.includes(f) && f !== ctx.file) ctx.mentions.push(f);
		mentionEl.hidden = true; renderChips(); autosize(); syncSend(); input.focus();
	}
	input.addEventListener('input', () => { mentionIdx = 0; showMentions(); });
	input.addEventListener('keydown', e => {
		if (mentionEl.hidden) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); mentionIdx = (mentionIdx + (e.key === 'ArrowDown' ? 1 : mentionMatches.length - 1)) % Math.max(1, mentionMatches.length); showMentions(); }
		else if ((e.key === 'Enter' || e.key === 'Tab') && mentionMatches.length) { e.preventDefault(); e.stopImmediatePropagation(); pickMention(mentionMatches[mentionIdx]); }
		else if (e.key === 'Escape') { mentionEl.hidden = true; }
	}, true);
	input.addEventListener('blur', () => setTimeout(() => { mentionEl.hidden = true; }, 150));

	send.onclick = () => {
		if (busy) { vscode.postMessage({ type: 'stop' }); return; }
		const text = input.value.trim(); if (!text) return;
		const payload = { file: ctx.file && !ctx.fileOff ? ctx.file : null, selection: ctx.file && !ctx.fileOff ? ctx.selection : null, mentions: ctx.mentions.slice() };
		ctx.mentions = []; renderChips();
		input.value = ''; autosize(); syncSend(); vscode.postMessage({ type: 'send', text, ctx: payload });
	};
	input.addEventListener('input', () => { autosize(); syncSend(); });
	input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.click(); } });
	// ⌘/Ctrl+Enter accepts and ⌘/Ctrl+Backspace rejects the pending proposal (Cursor-style)
	document.addEventListener('keydown', e => {
		if (!pending || !(e.metaKey || e.ctrlKey)) return;
		if (e.key === 'Enter') { e.preventDefault(); pending(true); }
		else if (e.key === 'Backspace' && document.activeElement !== input) { e.preventDefault(); pending(false); }
	});
	syncSend();
	vscode.postMessage({ type: 'ready' }); // the extension replays the saved chat
	$('new').onclick = () => vscode.postMessage({ type: 'new' });
	const historyEl = $('history');
	$('historyBtn').onclick = e => { e.stopPropagation(); if (historyEl.hidden) vscode.postMessage({ type: 'history' }); else historyEl.hidden = true; };
	document.addEventListener('click', e => { if (!historyEl.contains(e.target)) historyEl.hidden = true; });
	const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'now' : m < 60 ? m + 'm' : m < 1440 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd'; };
	function renderHistory(chats) {
		historyEl.replaceChildren(el('div', 'lc-history__label', 'Chats in this project'));
		if (!chats.length) historyEl.append(el('div', 'lc-history__empty', 'No saved chats yet.'));
		for (const c of chats) {
			const row = el('div', 'lc-history__item' + (c.current ? ' current' : ''));
			const open = el('button', 'open', c.title); open.title = c.title;
			open.onclick = () => { historyEl.hidden = true; vscode.postMessage({ type: 'openChat', id: c.id }); };
			const del = el('button', 'del', '×'); del.title = 'Delete this chat';
			del.onclick = e => { e.stopPropagation(); vscode.postMessage({ type: 'deleteChat', id: c.id }); };
			row.append(open, el('small', '', ago(c.updated)), del);
			historyEl.append(row);
		}
		historyEl.hidden = false;
	}
	const menu = $('modelMenu'), trigger = $('modelBtn');
	// lcai-chat-v2 components/model-logo.tsx brandFor(): simple-icons (CC0) Meta / Alibaba Cloud / Google
	const LOGOS = { meta: { color: "#0467DF", d: "M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z" }, alibaba: { color: "#FF6A00", d: "M3.996 4.517h5.291L8.01 6.324 4.153 7.506a1.668 1.668 0 0 0-1.165 1.601v5.786a1.668 1.668 0 0 0 1.165 1.6l3.857 1.183 1.277 1.807H3.996A3.996 3.996 0 0 1 0 15.487V8.513a3.996 3.996 0 0 1 3.996-3.996m16.008 0h-5.291l1.277 1.807 3.857 1.182c.715.227 1.17.889 1.165 1.601v5.786a1.668 1.668 0 0 1-1.165 1.6l-3.857 1.183-1.277 1.807h5.291A3.996 3.996 0 0 0 24 15.487V8.513a3.996 3.996 0 0 0-3.996-3.996m-4.007 8.345H8.002v-1.804h7.995Z" }, google: { color: "#4285F4", d: "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" } };
	function logo(name) {
		const id = name.toLowerCase();
		const b = id.startsWith('llama') ? LOGOS.meta : id.startsWith('qwen') ? LOGOS.alibaba : id.startsWith('gemma') ? LOGOS.google : null;
		if (!b) return null;
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'lc-logo');
		const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', b.d); p.setAttribute('fill', b.color); svg.append(p); return svg;
	}
	const dotState = mo => mo.workers === 0 ? 'off' : (mo.freeSlots === 0 ? 'busy' : 'ok');
	function dot(mo) { return Object.assign(document.createElement('span'), { className: 'lc-dot ' + dotState(mo) }); }
	function openMenu(open) { menu.hidden = !open; trigger.setAttribute('aria-expanded', String(open)); }
	trigger.onclick = e => { e.stopPropagation(); openMenu(menu.hidden); };
	document.addEventListener('click', e => { if (!$('modelBox').contains(e.target)) openMenu(false); });
	document.addEventListener('keydown', e => { if (e.key === 'Escape') openMenu(false); });
	function item(mo, selected) {
		const b = document.createElement('button'); b.type = 'button'; b.className = 'lc-model__item'; b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(selected));
		if (selected) b.append(Object.assign(document.createElement('span'), { className: 'lc-model__check' }));
		const row = document.createElement('span'); row.className = 'lc-model__row';
		const left = document.createElement('span'); left.className = 'lc-model__left';
		left.append(dot(mo)); const lg = logo(mo.name); if (lg) left.append(lg);
		left.append(Object.assign(document.createElement('span'), { className: 'n', textContent: mo.name }));
		const st = dotState(mo);
		const count = Object.assign(document.createElement('span'), { className: 'lc-model__count ' + st, textContent: st === 'off' ? 'Offline' : st === 'busy' ? 'Busy' : mo.workers + ' online' });
		row.append(left, count); b.append(row);
		if (st === 'off' && !selected) { b.disabled = true; b.title = 'No workers serve this model right now'; } // can't answer: not pickable
		b.onclick = () => { openMenu(false); if (!selected) vscode.postMessage({ type: 'model', name: mo.name }); };
		return b;
	}
	window.addEventListener('message', e => {
		const m = e.data;
		switch (m.type) {
			case 'reclaim': {
				const b = $('banner');
				b.hidden = !m.count;
				if (m.count) {
					const btn = smallBtn('Reclaim', true, () => { btn.disabled = true; vscode.postMessage({ type: 'reclaimStuck' }); });
					b.replaceChildren(el('span', '', m.fee + ' LCAI from ' + m.count + ' stalled job' + (m.count === 1 ? '' : 's') + ' can be reclaimed'), btn);
				}
				break;
			}
			case 'faucetState':
				faucet = m;
				renderSetup();
				break;
			case 'state':
				lastState = m; renderSetup();
				$('eyebrow').textContent = m.network; // the view header already says "Lightchain AI"
				$('credits').replaceChildren();
				if (m.account) { $('credits').append(m.credits ?? '—', Object.assign(document.createElement('span'), { textContent: m.credits === '1' ? ' credit' : ' credits' })); }
				else { $('credits').append(Object.assign(document.createElement('span'), { textContent: 'Connect wallet' })); }
				break;
			case 'user': {
				closeBubble();
				const u = el('div', 'lc-msg-user', m.text);
				if (m.chips && m.chips.length) { const cs = el('div', 'lc-msg-chips'); m.chips.forEach(c => cs.append(el('span', '', c))); u.append(cs); }
				add(u);
				break;
			}
			case 'info': closeBubble(); add(el('div', 'lc-checkpoint', m.text)); break;
			case 'checkpoint': {
				closeBubble(); clearStatus();
				const row = el('div', 'lc-checkpoint'); row.dataset.checkpoint = m.id;
				row.append(el('span', 'files', 'Changed ' + m.files.map(base).join(', ')));
				const b = smallBtn('Undo', false, () => { b.disabled = true; vscode.postMessage({ type: 'undoTurn', id: m.id }); setTimeout(() => { b.disabled = false; }, 1500); });
				b.title = 'Restore these files to how they were before this turn';
				row.append(b); add(row);
				break;
			}
			case 'checkpointUndone': {
				const row = thread.querySelector('[data-checkpoint="' + m.id + '"]');
				if (row) { row.classList.add('undone'); row.querySelector('button')?.remove(); row.append(el('span', '', 'Undone')); }
				break;
			}
			case 'context':
				if (m.file !== ctx.file) ctx.fileOff = false;
				ctx.file = m.file || null; ctx.selection = m.selection || null; renderChips();
				break;
			case 'files': allFiles = m.files || []; showMentions(); break;
			case 'historyList': renderHistory(m.chats || []); break;
			case 'ai': { const b = aiBubble(); currentText = m.text || ''; b.innerHTML = render(currentText); closeBubble(); break; }
			case 'focusInput': input.focus(); break;
			case 'restoreInput': if (!input.value.trim()) { input.value = m.text; autosize(); syncSend(); } break;
			case 'delta': { const b = aiBubble(); currentText += m.text; b.innerHTML = render(currentText); scroll(); break; }
			case 'toolStart': clearStatus(); lastTool = toolCard(m.name, m.summary); break;
			case 'toolEnd': {
				if (!lastTool) break;
				const row = lastTool.querySelector('.lc-step__row');
				if (row) {
					row.querySelector('.lc-ico')?.replaceWith(ico(m.ok ? 'ok' : 'err'));
					if (!m.ok && m.output) {
						// one quiet line: why it failed; the full output opens on click
						const why = m.output.split('\\n')[0].replace(/ — .*$/, '').replace(/\\.$/, '');
						row.append(el('span', 'lc-step__why', '· ' + (why.length > 48 ? why.slice(0, 47) + '…' : why)));
					}
					if (m.output && (!m.ok || m.name === 'forge_build' || m.name === 'run_command')) {
						const out = el('div', 'lc-step__out', m.output); out.hidden = true; lastTool.append(out); lastTool.classList.add('has-out');
					}
				} else {
					// an approval block: show the outcome in its header
					const st = lastTool.querySelector('.lc-edit__state');
					if (st && !m.ok) { st.textContent = 'Failed'; st.className = 'lc-edit__state err'; }
				}
				lastTool = null;
				break;
			}
			case 'approval': {
				lastTool?.remove(); // replaced by the proposal block
				const box = el('div', 'lc-edit');
				const head = el('div', 'lc-edit__head');
				if (m.kind === 'command') {
					head.append(ico('info'), el('span', '', 'Run command'));
				} else {
					const path = el('span', 'lc-edit__path', m.path || m.title);
					path.title = 'Open diff'; path.onclick = () => vscode.postMessage({ type: 'viewDiff', id: m.id });
					const stat = el('span', 'lc-edit__stat');
					if (m.diff) { stat.append(el('span', 'a', '+' + m.diff.added)); if (m.diff.removed) stat.append(el('span', 'r', '−' + m.diff.removed)); }
					head.append(path, stat);
				}
				const actions = el('div', 'lc-edit__actions');
				const declined = new Set(); // hunks the user switched off
				const total = m.diff ? m.diff.hunks || 0 : 0;
				const decide = ok => {
					pending = null;
					vscode.postMessage({ type: 'approve', id: m.id, ok, declined: [...declined] });
					const partial = ok && declined.size && declined.size < total;
					const st = el('span', 'lc-edit__state ' + (ok ? 'ok' : 'err'), ok ? (m.kind === 'command' ? 'Ran' : partial ? 'Accepted ' + (total - declined.size) + ' of ' + total : 'Accepted') : (m.kind === 'command' ? 'Skipped' : 'Rejected'));
					actions.replaceWith(st);
					if (!ok) box.classList.add('done');
				};
				actions.append(
					smallBtn(m.kind === 'command' ? 'Skip' : 'Reject', false, () => decide(false)),
					smallBtn(m.kind === 'command' ? 'Run' : 'Accept', true, () => decide(true), '⌘⏎'));
				head.append(actions);
				box.append(head);
				if (m.kind === 'command') {
					box.append(el('div', 'lc-edit__cmd', m.detail || ''));
				} else if (m.diff) {
					const d = el('div', 'lc-diff');
					let shown = -1;
					for (const line of m.diff.lines) {
						if (total > 1 && line.h !== undefined && line.h !== shown) {
							// one toggle per change, so parts of the proposal can be declined
							shown = line.h;
							const h = line.h;
							const bar = el('div', 'lc-hunk');
							const label = el('span', '', 'Change ' + (h + 1) + ' of ' + total);
							const t = el('button', 'lc-hunk__toggle', 'Keep');
							t.onclick = () => {
								if (declined.has(h)) declined.delete(h); else declined.add(h);
								const off = declined.has(h);
								t.textContent = off ? 'Declined' : 'Keep';
								t.classList.toggle('off', off);
								d.querySelectorAll('[data-h="' + h + '"]').forEach(x => x.classList.toggle('declined', off));
							};
							bar.append(label, t);
							d.append(bar);
						}
						const row = el('div', line.t === '+' ? 'add' : line.t === '-' ? 'del' : line.t === '…' ? 'gap' : 'ctx', line.t === '…' ? '⋯' : line.s);
						if (line.h !== undefined) row.dataset.h = String(line.h);
						d.append(row);
					}
					box.append(d);
				}
				closeBubble(); clearStatus();
				lastTool = add(box);
				pending = decide;
				break;
			}
			case 'models': {
				menu.replaceChildren(Object.assign(document.createElement('div'), { className: 'lc-model__label', textContent: 'Models' }));
				m.models.forEach(x => menu.append(item(x, x.name === m.selected)));
				const sel = m.models.find(x => x.name === m.selected);
				$('modelLabel').textContent = sel ? sel.name : 'Select model';
				$('modelDot').className = sel ? 'lc-dot ' + dotState(sel) : 'lc-dot';
				$('modelLogo').replaceChildren(...(sel && logo(sel.name) ? [logo(sel.name)] : []));
				break;
			}
			case 'turnEnd': closeBubble(); break;
			case 'status': setStatus(m.text, m.walletPrompt); break;
			case 'busy': setBusy(m.busy); if (!m.busy) { closeBubble(); clearStatus(); } break;
			case 'error': card({ title: m.message, state: 'Failed', stateKind: 'err' }); break;
			case 'card': card(m); break;
			case 'cardRemove': thread.querySelector('[data-card="' + m.id + '"]')?.remove(); break;
			case 'cardUpdate': {
				const el = thread.querySelector('[data-card="' + m.id + '"]');
				if (el) fillCard(el, m); else card(m);
				break;
			}
			case 'notice': card({ title: m.message, state: 'Done', stateKind: 'ok' }); break;
			case 'cleared': thread.replaceChildren(emptyState); current = null; lastTool = null; break;
		}
	});
</script>
</body>
</html>`;
	}

	dispose(): void {
		this.abort?.abort();
		this.disposables.forEach(d => d.dispose());
	}
}

const basename = (p: string) => p.split('/').pop() ?? p;

/** One readable line for wallet/RPC/protocol errors (viem errors are multi-paragraph). */
export function friendlyError(err: unknown, account?: { name: string; address: string }): string {
	const e = err as { name?: string; shortMessage?: string; message?: string; details?: string; code?: number };
	const text = `${e?.name ?? ''} ${e?.shortMessage ?? ''} ${e?.details ?? ''} ${e?.message ?? ''}`.toLowerCase();
	if (text.includes('insufficient funds') || text.includes('exceeds the balance')) {
		return `Not enough LCAI for gas${account ? ` in ${account.name} (${account.address.slice(0, 6)}…${account.address.slice(-4)})` : ''}. Add testnet LCAI from lightfaucet.ai.`;
	}
	if (e?.code === 4001 || text.includes('user rejected') || text.includes('user denied') || text.includes('rejected in the wallet')) {
		return 'Rejected in your wallet.';
	}
	return (e?.shortMessage ?? e?.message ?? String(err)).split('\n')[0].slice(0, 300);
}

function summarize(name: string, args: Record<string, any>): string {
	switch (name) {
		case 'read_file': return `Read ${args.path}`;
		case 'list_dir': return `List ${args.path ?? '.'}`;
		case 'search': return `Search “${args.query}”`;
		case 'write_file': return `Write ${args.path}`;
		case 'edit_file': return `Edit ${args.path}`;
		case 'forge_build': return 'forge build';
		case 'run_command': return `$ ${args.command}`;
		default: return name;
	}
}

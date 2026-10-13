import * as vscode from 'vscode';
import { claimTestnetLcai } from './faucet';
import * as path from 'node:path';
import { applyHunks, lineDiff } from './agent/lineDiff';
import { ChatStore, ChatEvent } from './agent/chatStore';
import { runInlineEdit } from './agent/inlineEdit';
import { StuckJobs } from './lightchain/stuckJobs';
import { MentionItem, MentionResolver, PromptContext, buildContext, contextFiles, editorContext, mentionableFiles, mentionedRules } from './agent/context';
import { RuleStore, renderRules } from './agent/rules';
import { Hit, renderHits } from './agent/localIndex';
import { SLASH_COMMANDS, expandSlash, parseSlash } from './agent/commands';
import { fixPrompt } from './failureWatcher';
import { Task, TaskStore, parseChecklist, taskPrompt } from './tasks';
import { AgentProfile, AgentProfiles, BUILTIN_AGENTS, flow } from './agent/profiles';
import { IDENTICON_JS } from './ui/site';

const BUILTIN_IDS = new Set(BUILTIN_AGENTS.map(a => a.id));
import type { ChatSummary } from './workspaceView';
import { outlineSolidity } from './agent/projectMap';
import { AgentStuckError } from './agent/agent';
import * as fs from 'node:fs';
import { NetworkState } from './networkState';
import { Wallet } from './wallet';
import { shortAddress } from './deployedPrograms';
import { txUrl } from './networks';
import { Credits, formatLcai, JOB_FEE_LCAI } from './credits';
import { Agent, InferenceProvider } from './agent/agent';
import { ApprovalRequest, PartialApproval } from './agent/tools';
import { ProposalStore } from './agent/proposals';
import { EditorReview, ReviewOutcome } from './editorReview';
import { InlinePrompt, InlineSession } from './inlinePrompt';
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


export class LightchainAiView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view?: vscode.WebviewView;
	private readonly disposables: vscode.Disposable[] = [];
	private generation = 0;
	private agent?: Agent;
	private abort?: AbortController;
	private approvals = new Map<string, { resolve: (decision: boolean | PartialApproval) => void; req: ApprovalRequest; review?: string }>();
	/** Shows proposed file changes inside the editor (set by the extension). */
	review?: EditorReview;
	/** The ⌘I prompt shown in the editor (set by the extension). */
	inline?: InlinePrompt;
	/** Builds the project map (set by the extension). */
	projectMap?: () => Promise<string>;
	/** What the @-picker offers, and how non-file mentions become context (set by the extension). */
	mentions?: () => Promise<MentionItem[]>;
	resolveMention?: MentionResolver;
	private seq = 0;
	private pendingDelegate?: `0x${string}`;
	private retryText?: string; // prompt to send again once a setup step (credits) is done
	private models: LightchainModel[] = [];
	private model?: string;
	private slowTimer?: ReturnType<typeof setTimeout>;
	/** Per turn: files the agent wrote, with their content before the turn (undefined = created). */
	private checkpoints = new Map<string, Map<string, { before?: string; after: string }>>();
	private turnOrder: string[] = []; // turns in the order they ran
	/** The project's first-dApp steps (set by the extension); shown as the panel's next step. */
	startSteps?: () => Promise<{ id: string; title: string; sub: string; done: boolean; command: string; action: string }[] | undefined>;
	/** Agent profiles (set by the extension). */
	profiles?: AgentProfiles;
	/** The project's instructions (set by the extension). */
	rules?: RuleStore;
	/** Local project search: code related to a request, without the files it already carries (set by the extension). */
	localSearch?: (query: string, exclude: string[]) => Promise<Hit[]>;
	private profile(): AgentProfile | undefined {
		return this.profiles?.get(this.memento.get<string>('lightchain.ai.agent', 'builder'));
	}
	/** The project's task board (set by the extension). */
	tasks?: TaskStore;
	private plannedTasks: { title: string; description?: string }[] = [];
	private lastTurnOk = false;
	private readonly chatsChanged = new vscode.EventEmitter<void>();
	readonly onDidChangeChats = this.chatsChanged.event;
	private turnJobs: { jobId: string; txHash?: string }[] = []; // on-chain jobs of the running turn
	private turnMarks = new Map<string, number>(); // user turn → agent history size before it
	private currentTurn?: string;
	private autoRetried = false; // one automatic retry per request after a worker failure
	private lastCredits?: number; // LCAI, from the last balance read
	private readonly stuck: StuckJobs;
	private readonly chats: ChatStore;
	private attached = new Map<string, string>(); // files attached in this conversation (not re-sent unchanged)
	private refreshedThisTurn = false;
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
		if (['user', 'turnEnd', 'checkpoint', 'cleared', 'checkpointUndone'].includes(m.type)) {
			queueMicrotask(() => this.chatsChanged.fire());
		}
		if (m.type === 'turnEnd' || m.type === 'replyEnd' || m.type === 'toolStart') {
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
			case 'agent':
				if (typeof msg.id === 'string') {
					await this.selectAgent(msg.id);
				}
				return;
			case 'openFile': {
				const root = vscode.workspace.workspaceFolders?.[0]?.uri;
				const rel = String(msg.path ?? '');
				if (root && rel && !rel.split(/[\\/]/).includes('..')) {
					await vscode.window.showTextDocument(vscode.Uri.joinPath(root, rel), { preview: true }).then(undefined, () => undefined);
				}
				return;
			}
			case 'openUrl': {
				const url = String(msg.url ?? '');
				if (url.startsWith(this.network.current.explorerUrl + '/')) {
					void vscode.env.openExternal(vscode.Uri.parse(url));
				}
				return;
			}
			case 'editAgent':
				return void vscode.commands.executeCommand('lightchain.agents.open', String(msg.id ?? ''));
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
			case 'rewind':
				return this.rewind(String(msg.turn), String(msg.text ?? ''));
			case 'files':
				this.post({ type: 'files', items: this.mentions ? await this.mentions() : (await mentionableFiles()).map(f => ({ id: f, label: f, kind: 'file' })) });
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
				this.agent?.setProvider(this.chatProvider(msg.name)); // same conversation, new model
				this.attached = new Map(); // the new session has not seen any file
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
				this.postAgents();
				return this.replay();
			case 'history':
				this.post({ type: 'historyList', chats: this.chats.all().map(c => ({ id: c.id, title: c.title, updated: c.updated, current: c.id === this.chats.current()?.id })) });
				return;
			case 'openChat':
				return typeof msg.id === 'string' ? this.openChat(msg.id) : undefined;
			case 'addPlan': {
				const n = this.plannedTasks.length && this.tasks ? await this.tasks.addMany(this.plannedTasks) : 0;
				this.plannedTasks = [];
				this.post({ type: 'cardRemove', id: 'plan' });
				if (n) {
					this.post({ type: 'info', text: `Added ${n} task${n === 1 ? '' : 's'} to the board.` });
					void vscode.commands.executeCommand('lightchain.tasks.board');
				}
				return;
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
					// a Lightchain session is bound to one model: the next prompt opens a new one with a recap
					this.agent?.setProvider(this.chatProvider(msg.name));
					this.attached = new Map(); // the new session has not seen any file
					this.post({ type: 'models', models: this.models, selected: this.model });
					this.post({ type: 'notice', message: this.agent ? `Model: ${msg.name}. The conversation continues.` : `Model: ${msg.name}.` });
				}
				return;
			case 'approve': {
				const a = this.approvals.get(msg.id);
				if (a) {
					this.approvals.delete(msg.id);
					if (a.review) {
						await this.review?.cancel(a.review); // decided in the panel: the editor goes back to the file as it was
					}
					const declined: number[] = Array.isArray(msg.declined) ? msg.declined.filter((n: unknown) => typeof n === 'number') : [];
					this.settle(a, !!msg.ok, declined);
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

	/** `instruction`: what the agent gets when it differs from the text shown in the chat. */
	private async send(request: string, retry = false, ctx?: PromptContext, instruction?: string): Promise<void> {
		if (!request.trim() || this.abort) {
			return;
		}
		if (!retry) {
			this.autoRetried = false;
			void this.memento.update('lightchain.ai.asked', true);
		}
		// slash commands: /explain /audit /test /fix /doc expand into full instructions; /deploy opens the wizard
		instruction ??= request;
		const slash = retry ? undefined : parseSlash(request);
		if (slash?.command.name === 'deploy') {
			const contract = ctx?.file?.endsWith('.sol') ? await this.firstContract(ctx.file) : undefined;
			await vscode.commands.executeCommand('lightchain.deployContract', contract);
			return;
		}
		if (slash) {
			const where = ctx?.file ? (ctx.selection ? `lines ${ctx.selection.start}–${ctx.selection.end} of ${ctx.file}` : ctx.file) : undefined;
			const scope = where ? `${where}${ctx?.mentions.length ? ' and the attached items' : ''}` : ctx?.mentions.length ? 'the attached items' : 'the contracts in this project';
			instruction = expandSlash(request, scope) ?? request;
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
		// Files the session has already seen unchanged are not sent again; they count as sent once the turn succeeds.
		const attaching = new Map(this.agent ? this.attached : []);
		// Instructions scoped to these files (or @-mentioned) and code found by local search ride along,
		// once per session each.
		const files = ctx ? contextFiles(ctx) : [];
		const extra: string[] = [];
		const fresh = <T,>(items: T[], key: (x: T) => string, body: (x: T) => string) => items.filter(x => attaching.get(key(x)) !== body(x) && (attaching.set(key(x), body(x)), true));
		const scoped = fresh(this.rules?.scoped(files, ctx ? mentionedRules(ctx) : []) ?? [], r => `rule:${r.id}`, r => r.body);
		if (scoped.length) {
			extra.push(`Instructions for this request (follow them):\n${renderRules(scoped, 1_600).text}`);
		}
		const query = slash ? request.replace(/^\s*\/\w+\s*/, '') : request;
		const found = fresh(query.trim() ? await this.localSearch?.(query, files).catch(() => []) ?? [] : [], h => `found:${h.path}:${h.start}`, h => h.text);
		if (found.length) {
			extra.push(renderHits(found));
		}
		let text = (await buildContext(ctx ?? { mentions: [] }, attaching, this.resolveMention, extra)) + instruction;
		if (this.recap && !this.agent) {
			text = `Earlier in this conversation (recap — you are continuing it):\n${this.recap}\n\n---\n\n${text}`;
			this.recap = undefined;
		}
		this.refreshedThisTurn = false;
		this.agent ??= new Agent(this.chatProvider(this.model), {
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
		}, this.profile());
		this.abort = new AbortController();
		const turnId = `t${++this.seq}`;
		if (!retry) {
			const chips = ctx ? [...(ctx.file ? [ctx.selection ? `${basename(ctx.file)} · L${ctx.selection.start}–${ctx.selection.end}` : basename(ctx.file)] : []), ...ctx.mentions.map(mentionLabel)] : [];
			this.post({ type: 'user', text: request, chips: [...chips, ...scoped.map(r => r.title)], found: found.map(h => ({ label: `${basename(h.path)} · L${h.start}–${h.end}`, title: `${h.path}${h.label ? ` — ${h.label}` : ''}` })), turn: turnId });
			this.turnMarks.set(turnId, this.agent.size);
		}
		this.turnOrder.push(turnId);
		this.post({ type: 'busy', busy: true });
		this.post({ type: 'status', text: 'Starting…' });
		this.inFlight = { text };
		let autoRetry: { text: string; model: string } | undefined;
		this.currentTurn = turnId;
		this.turnJobs = [];
		this.lastTurnOk = false;
		this.checkpoints.set(turnId, new Map());
		const clearSlow = () => { clearTimeout(this.slowTimer); this.slowTimer = undefined; this.post({ type: 'cardRemove', id: 'slow' }); };
		try {
			this.agent.setProjectMap(await this.projectMap?.().catch(() => '') ?? '');
			await this.agent.run(text, {
				onText: delta => { clearSlow(); this.post({ type: 'delta', text: delta }); },
				onToolStart: call => this.post({ type: 'toolStart', name: call.name, summary: summarize(call.name, call.args) }),
				onToolEnd: (call, result, soft) => soft
					? this.post({ type: 'status', text: 'Lightchain AI is adjusting its approach…' })
					: this.post({ type: 'toolEnd', name: call.name, ok: result.ok, output: result.output.slice(0, 600) }),
				onTurnEnd: () => this.post({ type: 'turnEnd' }),
				onReplyEnd: () => this.post({ type: 'replyEnd' }),
				onStatus: (status, o) => {
					this.post({ type: 'status', text: status, walletPrompt: !!o?.walletPrompt });
					const job = /^Job (\d+) submitted/.exec(status)?.[1];
					if (job && this.inFlight) {
						this.inFlight.job = job;
						clearTimeout(this.slowTimer);
						this.slowTimer = setTimeout(() => this.suggestOtherModels(job), SLOW_AFTER_MS);
					}
				},
			}, this.abort.signal, instruction);
			this.lastTurnOk = true;
			// /plan: offer the checklist as board tasks
			if (slash?.command.name === 'plan' && this.tasks) {
				const items = parseChecklist(this.agent.lastReply());
				if (items.length) {
					this.plannedTasks = items;
					this.post({ type: 'card', id: 'plan', title: `Add ${items.length} task${items.length === 1 ? '' : 's'} to the board?`, state: '', stateKind: 'info', detail: items.map(i => '• ' + i.title).join('\n'), actions: [{ label: `Add ${items.length} tasks`, command: 'addPlan' }] });
				}
			}
			this.attached = this.refreshedThisTurn ? new Map() : attaching;
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
			if (this.turnJobs.length) {
				// every reply is a job on Lightchain: show where to verify it and what it cost
				const net = this.network.current;
				this.post({
					type: 'jobs', count: this.turnJobs.length, cost: +(this.turnJobs.length * JOB_FEE_LCAI).toFixed(4),
					jobs: this.turnJobs.map(j => ({ id: j.jobId, url: j.txHash ? txUrl(net, j.txHash) : undefined })),
				});
				this.turnJobs = [];
			}
			const changed = this.checkpoints.get(turnId);
			if (changed?.size) {
				const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
				this.post({ type: 'checkpoint', id: turnId, files: [...changed.keys()].map(f => path.relative(root, f)) });
			} else {
				this.checkpoints.delete(turnId);
			}
			clearSlow();
			this.inFlight = undefined;
			this.approvals.forEach(a => { if (a.review) { void this.review?.cancel(a.review); } a.resolve(false); });
			this.approvals.clear();
			this.abort = undefined;
			this.post({ type: 'busy', busy: false });
			this.postState();
		}
		if (autoRetry) {
			// a new session: the failed one is bound to the stalled worker
			this.model = autoRetry.model;
			this.agent?.setProvider(this.chatProvider(autoRetry.model));
			this.attached = new Map(); // the new session has not seen any file
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

	/** A provider for chat turns; tells the user when the conversation moves to a fresh session. */
	private chatProvider(model: string): InferenceProvider {
		const provider = this.provider(model) as InferenceProvider & { onRefresh?: () => void; onJob?: (job: { jobId: string; txHash?: string }) => void };
		provider.onJob = job => this.turnJobs.push(job);
		provider.onRefresh = () => {
			this.refreshedThisTurn = true; // the new session has not seen the attached files
			this.post({ type: 'info', text: 'Long conversation: continuing in a fresh Lightchain session with a recap of the chat so far.' });
		};
		return provider;
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
		const where = `${startLine === endLine ? `line ${startLine + 1}` : `lines ${startLine + 1}–${endLine + 1}`}`;
		let session: InlineSession | undefined;
		let instruction: string | undefined;
		if (this.inline) {
			session = await this.inline.ask(doc, range, `Edit ${where} with Lightchain AI · ${model}`);
			instruction = session?.instruction;
		} else {
			instruction = await vscode.window.showInputBox({ title: `Edit with Lightchain AI · ${model}`, prompt: `${where} of ${vscode.workspace.asRelativePath(doc.uri, false)}`, placeHolder: 'Describe the change, e.g. add a require that msg.value > 0', ignoreFocusOut: true });
		}
		while (instruction?.trim()) {
			const original = doc.getText(range);
			const version = doc.version;
			const fail = async (message: string): Promise<string | undefined> => {
				if (!session) {
					vscode.window.showErrorMessage(message);
					return undefined;
				}
				session.status(`${message}\n\nEdit the instruction and send it again, or close this box.`);
				return session.retry();
			};
			let replacement: string | undefined;
			try {
				const ac = new AbortController();
				const report = (status: string) => session?.status(`${status}`);
				replacement = session
					? await runInlineEdit(this.provider(model), { file: vscode.workspace.asRelativePath(doc.uri, false), language: doc.languageId, text: doc.getText(), startLine: startLine + 1, endLine: endLine + 1, instruction: instruction.trim() }, ac.signal, report)
					: await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Lightchain AI · ${model}`, cancellable: true }, async (progress, token) => {
						token.onCancellationRequested(() => ac.abort());
						return runInlineEdit(this.provider(model), { file: vscode.workspace.asRelativePath(doc.uri, false), language: doc.languageId, text: doc.getText(), startLine: startLine + 1, endLine: endLine + 1, instruction: instruction!.trim() }, ac.signal, status => progress.report({ message: status }));
					});
			} catch (err) {
				instruction = await fail(err instanceof WorkerError || err instanceof SubmitError ? err.message : friendlyError(err, this.wallet.active));
				continue;
			} finally {
				this.postState();
			}
			if (!replacement || replacement === original) {
				instruction = await fail('Lightchain AI suggested no change.');
				continue;
			}
			if (doc.version !== version) {
				instruction = await fail('The file changed while Lightchain AI was working, so the edit was not applied.');
				continue;
			}
			session?.close();
			// review it in place like an agent change: Accept / Reject per change (saved when decided)
			if (!doc.isDirty && doc.uri.scheme === 'file' && this.review) {
				const before = doc.getText();
				const after = before.slice(0, doc.offsetAt(range.start)) + replacement + before.slice(doc.offsetAt(range.end));
				if (await this.review.start(doc.uri.fsPath, before, after, () => { })) {
					return;
				}
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
			return;
		}
	}

	private async firstContract(file: string): Promise<string | undefined> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!root) {
			return undefined;
		}
		const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, file)).then(b => b, () => new Uint8Array()));
		return outlineSolidity(text, false).find(u => !/interface|library/.test(u.kind))?.name;
	}

	// ---- for the Lightchain sidebar (WorkspaceView) and the board ----

	chatList(): ChatSummary[] {
		const current = this.chats.current()?.id;
		return this.chats.all().map(c => ({
			id: c.id, title: c.title, updated: c.updated, model: c.model, current: c.id === current,
			files: new Set(c.events.filter(e => e.type === 'checkpoint').flatMap(e => (e.files as string[] | undefined) ?? [])).size,
		}));
	}

	async openChat(id: string): Promise<void> {
		await vscode.commands.executeCommand('lightchain.ai.focus');
		if (this.abort || this.chats.current()?.id === id) {
			return;
		}
		await this.chats.open(id);
		this.view?.webview.postMessage({ type: 'cleared' });
		this.replay();
		this.chatsChanged.fire();
	}

	async newChat(): Promise<void> {
		await vscode.commands.executeCommand('lightchain.ai.focus');
		if (!this.abort) {
			this.resetChat();
		}
	}

	/** Hand a board task to Lightchain AI: In progress while it works, Review when it is done. */
	async runTask(task: Task): Promise<void> {
		if (this.abort) {
			vscode.window.showInformationMessage('Lightchain AI is busy with another request.');
			return;
		}
		await vscode.commands.executeCommand('lightchain.ai.focus');
		const prefix = this.tasks?.prefix ?? 'LC';
		await this.tasks?.update(task.id, { status: 'doing' });
		await this.send(`${prefix}-${task.key} · ${task.title}`, false, undefined, taskPrompt(task, prefix));
		await this.tasks?.update(task.id, { chat: this.chats.current()?.id, ...(this.lastTurnOk ? { status: 'review' } : {}) });
	}

	/** A project just created from a description: shape the starter into it. */
	async buildFromDescription(description: string, template: string): Promise<void> {
		await vscode.commands.executeCommand('lightchain.ai.focus');
		const instruction = [
			`This project was just created from the "${template}" starter. Turn it into: ${description}`,
			'',
			'First give a short plan (3 to 6 steps). Then change the contract in src/, its tests in test/ and the deploy script in script/ to match — complete files, simple and safe, for Lightchain testnet first. Rename files and contracts to fit the app. Then build and run the tests and fix any failures. Finish with how to deploy and try it.',
		].join('\n');
		await this.send(`Build: ${description}`, false, undefined, instruction);
	}

	modelNames(): string[] {
		return this.models.map(m => m.name);
	}

	/** Switch the chat's agent; its role, rules and permissions apply from the next message. */
	async selectAgent(id: string): Promise<void> {
		const p = this.profiles?.get(id);
		if (!p) {
			return;
		}
		await this.memento.update('lightchain.ai.agent', p.id);
		if (p.model && p.model !== this.model && this.models.some(m => m.name === p.model && m.available)) {
			this.model = p.model;
			await this.memento.update('lightchain.ai.model', p.model);
			this.post({ type: 'models', models: this.models, selected: this.model });
		}
		if (this.agent && this.model) {
			this.agent.setProfile(p);
			this.agent.setProvider(this.chatProvider(this.model)); // a new session picks up the new instructions
			this.attached = new Map();
			this.post({ type: 'notice', message: `Agent: ${p.name}. The conversation continues.` });
		}
		this.postAgents();
	}

	/** Tells the panel which agents exist and which one is active. */
	postAgents(): void {
		const all = this.profiles?.all ?? [];
		const cur = this.profile();
		const strip = (p: AgentProfile) => ({ id: p.id, edited: BUILTIN_IDS.has(p.id) && !!this.profiles?.isCustomized(p.id), custom: !BUILTIN_IDS.has(p.id), name: p.name, glyph: p.glyph, color: p.color, summary: p.summary, starters: p.starters.filter(Boolean), steps: flow(p).filter(s => s.on).map(s => ({ id: s.id, label: s.label })) });
		this.view?.webview.postMessage({ type: 'agents', agents: all.map(strip), current: cur ? strip(cur) : undefined });
	}

	/** Use an agent from Agent Studio (optionally sending one of its example requests). */
	async useAgent(id: string, prompt?: string): Promise<void> {
		await vscode.commands.executeCommand('lightchain.ai.focus');
		await this.selectAgent(id);
		if (prompt) {
			await this.send(prompt, false, editorContext().file ? { ...editorContext(), mentions: [] } : undefined);
		}
	}

	/** Re-reads credits and steps into the panel (e.g. after a build or deploy). */
	refreshState(): void {
		void this.postState();
	}

	/** A one-off provider for side jobs (commit messages); undefined without a wallet or model. */
	sideProvider(): InferenceProvider | undefined {
		return this.wallet.active && this.model ? this.provider(this.model) : undefined;
	}

	/** Plan with AI (from the board). */
	async plan(goal: string): Promise<void> {
		await vscode.commands.executeCommand('lightchain.ai.focus');
		await this.send(`/plan ${goal}`);
	}

	/** /audit for one file (from the deploy wizard). */
	async audit(file: string): Promise<void> {
		await vscode.commands.executeCommand('lightchain.ai.focus');
		await this.send('/audit', false, { file, mentions: [] });
	}

	/** A forge command failed: send its output to the chat to be fixed. */
	async fixFailure(command: string, output: string): Promise<void> {
		await vscode.commands.executeCommand('lightchain.ai.focus');
		await this.send(`Fix the failing \`${command}\``, false, undefined, fixPrompt(command, output));
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
		const { ok, message } = await claimTestnetLcai(account.address);
		this.post({ type: 'faucetState', busy: false, ok, message });
		if (ok) {
			// the transfer needs a block or two
			setTimeout(() => this.postState(), 6_000);
			setTimeout(() => this.postState(), 15_000);
		}
	}

	/** Restore every file the agent wrote in one turn to its state before the turn. */
	private async undoTurn(id: string): Promise<void> {
		if (await this.restoreTurns([id])) {
			this.post({ type: 'checkpointUndone', id });
		}
	}

	/**
	 * Edit an earlier message: undo the file changes from that message on, forget
	 * the conversation after it, and put the text back in the composer.
	 */
	private async rewind(turn: string, text: string): Promise<void> {
		if (this.abort) {
			this.abort.abort();
			await this.until(() => !this.abort);
		}
		const from = this.turnOrder.indexOf(turn);
		const later = from >= 0 ? this.turnOrder.slice(from) : [];
		if (!(await this.restoreTurns(later.reverse()))) {
			return;
		}
		this.turnOrder = from >= 0 ? this.turnOrder.slice(0, from) : this.turnOrder;
		const mark = this.turnMarks.get(turn);
		if (this.agent && mark !== undefined && this.model) {
			this.agent.truncate(mark);
			this.agent.setProvider(this.chatProvider(this.model)); // the worker session still holds the old turns
			this.attached = new Map();
		}
		this.chats.rewind(turn);
		const chat = this.chats.current();
		if (!this.agent && chat) {
			this.recap = ChatStore.summary(chat); // a restored chat: the next prompt starts a session from this
		}
		this.view?.webview.postMessage({ type: 'rewound', turn, text });
	}

	/** Restores the files written in `ids` (newest first); false when the user cancels. */
	private async restoreTurns(ids: string[]): Promise<boolean> {
		const turns = ids.map(id => this.checkpoints.get(id)).filter((t): t is Map<string, { before?: string; after: string }> => !!t && t.size > 0);
		if (!turns.length) {
			ids.forEach(id => this.checkpoints.delete(id));
			return true;
		}
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
		const current = async (f: string) => {
			const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === f);
			return open ? open.getText() : fs.promises.readFile(f, 'utf8').catch(() => undefined);
		};
		// the newest version each file got from these turns, and the oldest "before"
		const newest = new Map<string, string>();
		const oldest = new Map<string, string | undefined>();
		for (const turn of turns) { // newest turn first
			for (const [f, v] of turn) {
				if (!newest.has(f)) {
					newest.set(f, v.after);
				}
				oldest.set(f, v.before);
			}
		}
		const edited: string[] = [];
		for (const [f, after] of newest) {
			if ((await current(f)) !== after) {
				edited.push(path.relative(root, f));
			}
		}
		if (edited.length) {
			const ok = await vscode.window.showWarningMessage(
				`${edited.join(', ')} changed after Lightchain AI wrote ${edited.length === 1 ? 'it' : 'them'}.`,
				{ modal: true, detail: 'Undo restores the version from before this turn and discards those later edits.' },
				'Undo Anyway');
			if (ok !== 'Undo Anyway') {
				return false;
			}
		}
		for (const [f, before] of oldest) {
			const uri = vscode.Uri.file(f);
			if (before === undefined) {
				await vscode.workspace.fs.delete(uri, { useTrash: true }).then(undefined, () => undefined);
			} else {
				await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(before));
			}
		}
		ids.forEach(id => this.checkpoints.delete(id));
		return true;
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
		// "Apply automatically" agents: file changes go straight in (the turn's checkpoint can undo them)
		if (req.kind !== 'command' && this.profile()?.approval === 'auto') {
			return Promise.resolve(true);
		}
		const id = `a${++this.seq}`;
		return new Promise(resolve => {
			const entry: { resolve: typeof resolve; req: ApprovalRequest; review?: string } = { resolve, req };
			this.approvals.set(id, entry);
			const diff = req.diff ? lineDiff(req.diff.before ?? '', req.diff.after) : undefined;
			this.post({ type: 'approval', id, kind: req.kind, title: req.title, detail: req.detail, path: req.diff?.path, diff, isNew: req.diff ? !req.diff.before : undefined });
			// a change to an existing file is also shown in the file itself, with Accept / Reject per change
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (this.review && root && req.diff?.before && req.kind !== 'command') {
				const abs = path.join(root, req.diff.path);
				void this.review.start(abs, req.diff.before, req.diff.after, outcome => this.fromEditor(id, outcome)).then(shown => {
					if (shown && this.approvals.get(id) === entry) {
						entry.review = abs;
						this.post({ type: 'approvalInEditor', id });
					}
				});
			}
		});
	}

	/** Every change of a proposal was decided in the editor. */
	private fromEditor(id: string, outcome: ReviewOutcome): void {
		const a = this.approvals.get(id);
		if (!a || outcome === 'cancelled') {
			return;
		}
		this.approvals.delete(id);
		const ok = outcome !== 'rejected';
		const declined = ok ? outcome.declined : [];
		this.settle(a, ok, declined);
		this.post({ type: 'approvalResolved', id, ok, declined });
	}

	private settle(a: { resolve: (decision: boolean | PartialApproval) => void; req: ApprovalRequest }, ok: boolean, declined: number[]): void {
		const total = a.req.diff ? lineDiff(a.req.diff.before ?? '', a.req.diff.after).hunks : 0;
		if (!ok || (total && declined.length >= total)) {
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

	private async postState(): Promise<void> {
		const gen = ++this.generation;
		const account = this.wallet.active;
		const network = this.network.current;
		const base = {
			type: 'state', network: network.label, testnet: network.id === 'testnet',
			account: account ? shortAddress(account.address) : null, credits: null as string | null,
			gas: null as number | null, creditsNum: null as number | null,
			asked: this.memento.get<boolean>('lightchain.ai.asked', false),
			steps: await this.startSteps?.().catch(() => undefined),
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
	.lc-sm-title[hidden] { display: none; }
	.lc-edit__where { padding: 6px 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); color: #b1b3d0; font-size: 12px; }
	.lc-top__right { margin-left: auto; display: flex; align-items: center; gap: 16px; }
	/* model picker = lcai-chat-v2 components/model-picker.tsx (ModelSelect) + ui/dropdown-menu, dark tokens */
	.lc-model { position: relative; flex: 1; min-width: 0; }
	/* agent picker (site tokens: hairline square, greys) */
	.lc-agent { position: relative; flex: none; }
	.lc-agent__trigger { display: inline-flex; align-items: center; gap: 7px; height: 32px; max-width: 170px; padding: 0 6px; border: 0; background: transparent; color: #CCCEEF; font-family: "Inter", sans-serif; font-size: 12px; font-weight: 500; cursor: pointer; }
	.lc-agent__trigger:hover { color: #f5f6ff; }
	.lc-agent__glyph { flex: none; display: inline-flex; width: 20px; height: 20px; border-radius: 6px; overflow: hidden; background: #14152c; }
	.lc-agent__glyph svg { width: 100%; height: 100%; display: block; }
	.lc-agent__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.lc-model__menu.lc-agent__menu { width: 320px; min-width: 0; max-width: calc(100vw - 32px); max-height: 420px; }
	.lc-agent__item { position: relative; display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 8px; border-radius: 8px; background: transparent; text-align: left; cursor: pointer; outline: none; transition: background-color .15s; }
	.lc-agent__item .lc-agent__glyph { width: 28px; height: 28px; margin-top: 1px; }
	.lc-agent__item:hover, .lc-agent__item:focus-visible { background: #13131e; }
	.lc-agent__item.sel { background: #13131e; box-shadow: inset 2px 0 0 #5b4bff; }
	.lc-agent__item .t { flex: 1; display: flex; flex-direction: column; min-width: 0; }
	.lc-agent__item .n { display: flex; align-items: center; gap: 6px; color: #f5f6ff; font-family: "Inter", sans-serif; font-size: 13px; }
	.lc-agent__item .s { color: #7376aa; font-family: "Inter", sans-serif; font-size: 11.5px; line-height: 1.45; }
	.lc-agent__pill { padding: 0 6px; border: 1px solid rgba(91, 75, 255, 0.35); border-radius: 52px; color: #b1b3d0; font-size: 9.5px; font-weight: 500; letter-spacing: .5px; line-height: 15px; text-transform: uppercase; }
	.lc-agent__edit { flex: none; align-self: center; display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 8px; background: rgba(255, 255, 255, 0.06); color: #ccceef; font-family: "Inter", sans-serif; font-size: 11px; letter-spacing: .5px; text-transform: uppercase; cursor: pointer; opacity: 0; transition: opacity .15s, background-color .3s, border-color .3s; }
	.lc-agent__item:hover .lc-agent__edit, .lc-agent__item:focus-within .lc-agent__edit, .lc-agent__item.sel .lc-agent__edit { opacity: 1; }
	.lc-agent__edit:hover { border-color: #5b4bff; background: #5b4bff; color: #fff; }
	.lc-agent__edit svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
	.lc-agent__foot { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, 0.1); }
	.lc-agent__new, .lc-agent__manage { flex: 1; white-space: nowrap; height: 30px; padding: 0 10px; border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 8px; background: rgba(255, 255, 255, 0.06); color: #ccceef; font-family: "Inter", sans-serif; font-size: 11px; letter-spacing: .5px; text-transform: uppercase; cursor: pointer; transition: all .3s ease-in-out; }
	.lc-agent__new:hover, .lc-agent__manage:hover { border-color: #5b4bff; background: #5b4bff; color: #fff; }
	/* example requests for the chosen agent */
	.lc-starters { display: flex; flex-direction: column; gap: 2px; margin-top: 18px; text-align: left; }
	.lc-starters:empty { display: none; }
	.lc-starters::before { content: "TRY"; padding: 0 0 6px 12px; color: #ccceef; opacity: .5; font-size: 12px; font-weight: 600; letter-spacing: 0.5px; }
	.lc-starter { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border: 0; border-radius: 6px; background: transparent; color: #ccceef; font-family: "Inter", sans-serif; font-size: 14px; font-weight: 500; text-align: left; cursor: pointer; transition: all 400ms; }
	.lc-starter svg { flex: none; width: 16px; height: 16px; fill: none; stroke: #7376aa; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; transition: all 400ms; }
	.lc-starter:hover { background: #0f0f14; color: #5b4bff; }
	.lc-starter:hover svg { stroke: #5b4bff; }
	/* live agent flow: plain text steps, the current one underlined in magenta */
	.lc-flow { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; padding: 10px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); zoom: 0.8125; }
	.lc-flow[hidden] { display: none; }
	.lc-flow__who { flex: none; display: inline-flex; align-items: center; gap: 7px; margin-right: 4px; color: #f5f6ff; font-size: 13px; font-weight: 500; white-space: nowrap; }
	.lc-flow__step { flex: none; padding: 2px 0; border-bottom: 2px solid transparent; color: #7376aa; font-size: 13px; white-space: nowrap; }
	.lc-flow__step.done { color: #b1b3d0; }
	.lc-flow__step.now { color: #f5f6ff; border-bottom-color: #dd00ac; }
	.lc-flow__step.skip { opacity: .45; text-decoration: line-through; }
	.lc-flow__sep { flex: none; color: rgba(204, 206, 239, 0.3); font-size: 12px; }
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
	.lc-empty { margin: auto 0; text-align: center; }
	.lc-empty h2 { margin: 0 0 6px; color: #ccceef; font-size: 24px; font-weight: 600; letter-spacing: -0.02em; }
	.lc-empty img { width: 40px; height: auto; display: block; margin: 0 auto 16px; }
	.lc-empty p { color: #7376aa; font-size: 14px; line-height: 1.6; }
	/* first-run checklist */
	.lc-setup { margin-top: 24px; padding: 14px 16px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px; background: #0f0f14; text-align: left; }
	.lc-next__top { display: flex; align-items: center; gap: 8px; color: #7376aa; font-size: 12px; }
	.lc-next__bar { display: flex; gap: 3px; margin-left: auto; }
	.lc-next__bar i { width: 10px; height: 2px; background: rgba(204, 206, 239, 0.16); }
	.lc-next__bar i.on { background: #b1b3d0; }
	.lc-next__bar i.now { background: #5b4bff; }
	.lc-next__x { padding: 0 0 0 4px; border: 0; background: none; color: #7376aa; font-size: 15px; line-height: 1; cursor: pointer; }
	.lc-next__x:hover { color: #f5f6ff; }
	.lc-next__row { display: flex; align-items: center; gap: 12px; margin-top: 6px; }
	.lc-next__text { flex: 1; min-width: 0; }
	.lc-next__title { color: #ccceef; font-size: 15px; font-weight: 500; }
	.lc-next__note { color: #7376aa; font-size: 12.5px; line-height: 1.45; }
	.lc-setup[hidden] { display: none; }
	.lc-setup__title { margin: 12px 12px 8px; padding-left: 10px; border-left: 3px solid #dd00ac; color: #b1b3d0; font-size: 13px; font-weight: 500; line-height: 1.2; text-transform: uppercase; }
	.lc-setup__row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-top: 1px solid rgba(255, 255, 255, 0.1); font-size: 13px; color: #ccceef; }
	.lc-setup__n { flex: none; width: 16px; height: 16px; border: 1px solid rgba(204, 206, 239, 0.16); display: inline-flex; align-items: center; justify-content: center; font-size: 10px; color: #7376aa; }
	.lc-setup__row.done { color: #7376aa; }
	.lc-setup__row.done .lc-setup__n { border-color: #ccceef; background: #ccceef; color: #070710; }
	.lc-setup__row .t { flex: 1; min-width: 0; }
	.lc-setup__row .t small { display: block; color: #7376aa; font-size: 11px; }
	/* Chat layout in the style of Cursor / Claude, with lightchain.ai colours and type */
	.lc-thread > * { flex: none; } /* never squash blocks; the thread scrolls instead */
	.lc-msg-user { position: relative; }
	.lc-edits { margin: 0 0 8px; padding: 6px 10px; border: 1px solid rgba(204, 206, 239, 0.16); background: #020203; }
	.lc-edits[hidden] { display: none; }
	.lc-edits__head { display: flex; align-items: center; gap: 8px; }
	.lc-edits__toggle { flex: 1; min-width: 0; border: 0; background: none; color: #CCCEEF; font-family: "Inter", sans-serif; font-size: 12.5px; text-align: left; cursor: pointer; padding: 2px 0; }
	.lc-edits__list { display: flex; flex-direction: column; margin-top: 4px; }
	.lc-edits__file { border: 0; background: none; color: #9798B6; font-family: Menlo, Monaco, "Courier New", monospace; font-size: 11.5px; text-align: left; padding: 3px 4px; border-radius: 6px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.lc-edits__file:hover { background: rgba(204, 206, 239, 0.06); color: #f5f6ff; }
	.lc-jobs { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: -4px; color: #7376aa; font-size: 11px; }
	.lc-jobs a { color: #9798B6; text-decoration: none; font-family: Menlo, Monaco, "Courier New", monospace; }
	.lc-jobs a:hover { color: #f5f6ff; text-decoration: underline; }
	.lc-msg-edit { position: absolute; top: 6px; right: 8px; padding: 2px 8px; border: 0; border-radius: 6px; background: rgba(204, 206, 239, 0.08); color: #b1b3d0; font-family: "Inter", sans-serif; font-size: 11px; cursor: pointer; opacity: 0; transition: opacity .15s; }
	.lc-msg-user:hover .lc-msg-edit { opacity: 1; }
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
	/* P2P app .button.button-sm: glass, hairline, uppercase, 8px; hover fills with the accent */
	.lc-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: none; height: 28px; padding: 0 12px; border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 8px; background: rgba(255, 255, 255, 0.14); color: #ccceef; font-family: "Inter", sans-serif; font-size: 11px; font-weight: 400; letter-spacing: 0.5px; text-transform: uppercase; line-height: 1; cursor: pointer; white-space: nowrap; transition: all 300ms ease-in-out; }
	.lc-btn:hover { border-color: #5b4bff; background: #5b4bff; color: #ccceef; }
	.lc-btn.primary:hover { background: linear-gradient(90deg, #df04ae 0%, #412ffd 100%); box-shadow: 0 0 20px 5px rgba(112, 100, 233, 0.1); filter: brightness(125%); }
	.lc-btn.primary { border: 0; background: linear-gradient(90deg, #df04ae 0%, #412ffd 100%); color: #fff; }
	.lc-btn.primary:hover { filter: brightness(1.1); }
	.lc-btn:disabled { opacity: .5; cursor: default; }
	.lc-kbd { font-size: 11px; opacity: .75; }

	/* notes (setup steps, errors) */
	.lc-note { padding: 10px 12px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px; background: #020203; font-size: 13px; }
	.lc-note__head { display: flex; align-items: flex-start; gap: 8px; color: #f5f6ff; font-weight: 500; }
	.lc-note__head .lc-ico { margin-top: 3px; }
	.lc-note__text { margin: 4px 0 0 22px; color: #b1b3d0; line-height: 1.5; white-space: pre-line; }
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
	.lc-msg-chips span.found { background: transparent; box-shadow: inset 0 0 0 1px rgba(204, 206, 239, 0.12); }
	.lc-msg-chips span.found::before { content: ""; display: inline-block; width: 5px; height: 5px; margin: 0 5px 1px 0; border-radius: 50%; background: #5b4bff; }
	/* @-mention picker: same surface as the model menu */
	.lc-mention { position: absolute; left: 8px; right: 8px; bottom: calc(100% + 4px); z-index: 60; max-height: 220px; overflow-y: auto; padding: 6px; border: 1px solid rgba(204, 206, 239, 0.06); border-radius: 12px; background: #0F0F14; }
	.lc-mention[hidden] { display: none; }
	.lc-mention button { display: block; width: 100%; padding: 5px 8px; border: 0; border-radius: 8px; background: transparent; color: #CCCEEF; font-family: Menlo, Monaco, "Courier New", monospace; font-size: 12px; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.lc-mention button.active, .lc-mention button:hover { background: hsl(240 3.7% 15.9%); }
	.lc-mention button { display: flex; gap: 8px; align-items: baseline; }
	.lc-mention .lbl { flex: none; max-width: 60%; overflow: hidden; text-overflow: ellipsis; }
	.lc-mention .det { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: #7376aa; font-family: "Inter", sans-serif; font-size: 11px; }
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
		<h4 class="lc-sm-title" id="eyebrow" hidden>Testnet</h4>
		<div class="lc-top__right"><div class="lc-top__credits" id="credits" title="Lightchain AI credits"></div><button class="lc-link" id="historyBtn">History</button><button class="lc-link" id="new">New chat</button></div>
		<div class="lc-history" id="history" hidden></div>
	</div>
	<div class="lc-banner" id="banner" hidden></div>
	<div class="lc-flow" id="flowStrip" hidden></div>
	<div class="lc-thread" id="thread">
		<div class="lc-empty" id="empty">
			<img src="${media('lightchain-tab.svg')}" alt=""><h2>Ask Lightchain AI</h2>
			<p>Build, test and ship contracts with Lightchain AI. It reads your project and every change waits for your approval.</p>
			<div class="lc-setup" id="setup" hidden></div>
			<div class="lc-starters" id="starters"></div>
		</div>
	</div>
	<div class="lc-form">
		<div class="lc-edits" id="edits" hidden></div>
		<div class="lc-composer">
			<div class="lc-mention" id="mention" hidden></div>
			<div class="lc-chips" id="chips"></div>
			<textarea id="input" rows="2" placeholder="Ask Lightchain AI… @ to add context, / for commands"></textarea>
			<div class="lc-form__row">
				<div class="lc-agent" id="agentBox">
					<button class="lc-agent__trigger" id="agentBtn" type="button" title="Choose the agent"><span class="lc-agent__glyph" id="agentGlyph">CB</span><span class="lc-agent__name" id="agentName">Contract Builder</span><svg class="lc-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
					<div class="lc-model__menu lc-agent__menu" id="agentMenu" hidden></div>
				</div>
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
	${IDENTICON_JS}
	const $ = id => document.getElementById(id);
	const thread = $('thread');
	let busy = false, current = null, currentText = '';

	const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
	// the model's chatter around tool steps ("Please approve the changes.", "I apologize…", "Here are the tool calls:")
	const FILLER = /(^|\\n|(?<=[.!:]) *)(please (approve|confirm|accept|review)[^.!\\n]*[.!]?|i apologi[sz]e[^.!\\n]*[.!]|(sorry|my apologies)[^.!\\n]*[.!]|(here (is|are)|below (is|are)) the (corrected |updated |next |following )?((tool|json)[^.:!\\n]*|commands?|calls?)[.:!]?|i will now (call|use|run)[^.:!\\n]*[.:!]?)/gi;
	function render(text) {
		// hide tool-call JSON (shown as tool cards), render fenced code + inline code + bold
		const visible = text.replace(/\`\`\`(tool|json)[\\s\\S]*?(\`\`\`|$)/g, '').replace(FILLER, '').trim();
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
	// ---- agents: picker, starters, live flow ----
	let agentState = { agents: [], current: null };
	const agentMenu = $('agentMenu');
	function renderAgent() {
		const a = agentState.current; if (!a) return;
		$('agentBox').style.setProperty('--ac', a.color);
		$('agentGlyph').innerHTML = lcIdenticon('agent:' + a.id); $('agentName').textContent = a.name;
		const st = $('starters'); // only in the empty state
		if (st) st.replaceChildren();
		if (st) a.starters.forEach(s => { const b = el('button', 'lc-starter'); b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9"/></svg>'; b.append(document.createTextNode(s)); b.onclick = () => { input.value = s; autosize(); syncSend(); input.focus(); }; st.append(b); });
		agentMenu.replaceChildren(Object.assign(document.createElement('div'), { className: 'lc-model__label', textContent: 'Agents' }));
		agentState.agents.forEach(x => {
			const row = el('div', 'lc-agent__item' + (x.id === a.id ? ' sel' : ''));
			row.tabIndex = 0; row.setAttribute('role', 'button');
			const g = el('span', 'lc-agent__glyph'); g.innerHTML = lcIdenticon('agent:' + x.id);
			const t = el('span', 't'); const n = el('span', 'n', x.name);
			if (x.edited) n.append(el('span', 'lc-agent__pill', 'Edited'));
			else if (x.custom) n.append(el('span', 'lc-agent__pill', 'Yours'));
			t.append(n, el('span', 's', x.summary));
			const edit = el('button', 'lc-agent__edit'); edit.type = 'button'; edit.title = 'Edit ' + x.name;
			edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span>Edit</span>';
			edit.onclick = e => { e.stopPropagation(); agentMenu.hidden = true; vscode.postMessage({ type: 'editAgent', id: x.id }); };
			row.append(g, t, edit);
			const pick = () => { agentMenu.hidden = true; vscode.postMessage({ type: 'agent', id: x.id }); };
			row.onclick = pick; row.onkeydown = e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick());
			agentMenu.append(row);
		});
		const foot = el('div', 'lc-agent__foot');
		const nw = el('button', 'lc-agent__new', '+ New agent'); nw.type = 'button';
		nw.onclick = () => { agentMenu.hidden = true; vscode.postMessage({ type: 'command', command: 'lightchain.agents.new' }); };
		const ins = el('button', 'lc-agent__manage', 'Instructions'); ins.type = 'button'; ins.title = 'What every agent keeps in mind in this project';
		ins.onclick = () => { agentMenu.hidden = true; vscode.postMessage({ type: 'command', command: 'lightchain.rules.open' }); };
		const m = el('button', 'lc-agent__manage', 'Agent Studio'); m.type = 'button';
		m.onclick = () => { agentMenu.hidden = true; vscode.postMessage({ type: 'command', command: 'lightchain.agents.open' }); };
		foot.append(nw, ins, m);
		agentMenu.append(foot);
	}
	$('agentBtn').onclick = e => { e.stopPropagation(); agentMenu.hidden = !agentMenu.hidden; };
	document.addEventListener('click', e => { if (!$('agentBox').contains(e.target)) agentMenu.hidden = true; });
	// the strip lights up the step the agent is on
	let flowIdx = -1, flowSteps = [], flowSeen = new Set();
	function startFlow() {
		const a = agentState.current; if (!a) return;
		flowSteps = a.steps; flowIdx = 0; flowSeen = new Set([a.steps[0] && a.steps[0].id]);
		const s = $('flowStrip'); s.style.setProperty('--ac', a.color); s.hidden = false; drawFlow();
	}
	function drawFlow(finished) {
		const s = $('flowStrip'); const a = agentState.current; if (!a || !flowSteps.length) return;
		s.replaceChildren();
		const who = el('span', 'lc-flow__who'); const g = el('span', 'lc-agent__glyph'); g.innerHTML = lcIdenticon('agent:' + a.id); who.append(g, el('span', '', a.name)); s.append(who);
		flowSteps.forEach((st, i) => {
			if (i) s.append(el('span', 'lc-flow__sep', '›'));
			const seen = flowSeen.has(st.id) || (finished && st.id === 'answer');
			s.append(el('span', 'lc-flow__step' + (i === flowIdx && !finished ? ' now' : seen && (finished || i < flowIdx) ? ' done' : (finished || i < flowIdx) ? ' skip' : ''), st.label));
		});
	}
	function flowTo(id) {
		const i = flowSteps.findIndex(s => s.id === id);
		if (i >= 0 && i >= flowIdx) { flowIdx = i; flowSeen.add(id); drawFlow(); }
	}
	const TOOL_STEP = { read_file: 'read', list_dir: 'read', search: 'read', write_file: 'write', forge_build: 'build', forge_test: 'test' };
	// files Lightchain AI changed in this chat (checkpoint id → files)
	const sessionEdits = {};
	let editsOpen = false;
	function renderEdits() {
		const box = $('edits');
		const files = [...new Set(Object.values(sessionEdits).flat())];
		if (!files.length) { box.hidden = true; return; }
		box.hidden = false; box.replaceChildren();
		const head = el('div', 'lc-edits__head');
		const toggle = el('button', 'lc-edits__toggle', (editsOpen ? '– ' : '+ ') + files.length + ' file' + (files.length === 1 ? '' : 's') + ' changed in this chat');
		toggle.onclick = () => { editsOpen = !editsOpen; renderEdits(); };
		const commit = el('button', 'lc-btn', 'Commit with AI'); commit.title = 'Lightchain AI writes the commit message; you review and commit in Source Control';
		commit.onclick = () => vscode.postMessage({ type: 'command', command: 'lightchain.ai.commit' });
		head.append(toggle, commit); box.append(head);
		if (editsOpen) {
			const list = el('div', 'lc-edits__list');
			files.forEach(f => { const b = el('button', 'lc-edits__file', f); b.title = 'Open ' + f; b.onclick = () => vscode.postMessage({ type: 'openFile', path: f }); list.append(b); });
			box.append(list);
		}
	}
	const approvalUi = {}; // approval id → { done(ok, declined), inEditor() }
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
		// then the project's own first-dApp steps (build, test, deploy, call)
		const project = (s.steps || []).filter(x => x.id !== 'ask');
		project.forEach(x => steps.push({ title: x.title, note: x.sub, done: x.done, action: [x.action, () => vscode.postMessage({ type: 'command', command: x.command })], dismiss: true }));
		const next = steps.find(x => !x.done);
		box.hidden = !next;
		if (!next) return;
		// one quiet line: only what to do next
		const i = steps.indexOf(next);
		box.replaceChildren();
		const top = el('div', 'lc-next__top');
		top.append(el('span', '', 'Next step · ' + (i + 1) + ' of ' + steps.length));
		const bar = el('span', 'lc-next__bar'); steps.forEach(x => bar.append(el('i', x.done ? 'on' : x === next ? 'now' : ''))); top.append(bar);
		if (next.dismiss) { const x = el('button', 'lc-next__x', '×'); x.title = 'Hide the project guide'; x.onclick = () => vscode.postMessage({ type: 'command', command: 'lightchain.start.dismiss' }); top.append(x); }
		const row = el('div', 'lc-next__row');
		const t = el('div', 'lc-next__text'); t.append(el('div', 'lc-next__title', next.title)); if (next.note) t.append(el('div', 'lc-next__note', next.note));
		row.append(t);
		if (next.action) { const b = smallBtn(next.action[0], true, next.action[1]); if (next.action[2]) b.disabled = true; row.append(b); }
		box.append(top, row);
	}

	// ---- context chips + @-mentions ----
	const ctx = { file: null, selection: null, fileOff: false, mentions: [] };
	const chipsEl = $('chips'), mentionEl = $('mention');
	let allFiles = null, mentionIdx = 0, mentionMatches = [];
	const labels = {}; // mention id → chip label
	const COMMANDS = ${JSON.stringify(SLASH_COMMANDS.map(c => ({ name: c.name, hint: c.hint })))};
	const KIND = { file: '', contract: 'contract', deployed: 'deployed', tx: 'transaction', rule: 'instruction', command: '' };
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
		ctx.mentions.forEach((m, i) => chip('@' + (labels[m] || base(m)), m, () => { ctx.mentions.splice(i, 1); renderChips(); }));
	}
	function mentionQuery() {
		const before = input.value.slice(0, input.selectionStart);
		const m = /(^|\\s)@([^\\s@]*)$/.exec(before);
		return m ? m[2] : null;
	}
	function slashQuery() {
		const m = /^\\/(\\w*)$/.exec(input.value.slice(0, input.selectionStart));
		return m ? m[1].toLowerCase() : null;
	}
	function showMentions() {
		const sq = slashQuery();
		if (sq !== null) {
			mentionMatches = COMMANDS.filter(c => c.name.startsWith(sq)).map(c => ({ id: '/' + c.name, label: '/' + c.name, detail: c.hint, kind: 'command' }));
		} else {
			const q = mentionQuery();
			if (q === null) { mentionEl.hidden = true; return; }
			if (!allFiles) { vscode.postMessage({ type: 'files' }); allFiles = []; }
			const ql = q.toLowerCase();
			const extra = /^0x[0-9a-f]{64}$/i.test(q) ? [{ id: 'tx:' + q, label: 'tx ' + q.slice(0, 8) + '…' + q.slice(-4), detail: 'transaction on this network', kind: 'tx' }]
				: /^0x[0-9a-f]{40}$/i.test(q) && !allFiles.some(x => x.id.toLowerCase() === 'deployed:' + ql) ? [{ id: 'deployed:' + q, label: q.slice(0, 6) + '…' + q.slice(-4), detail: 'contract at this address', kind: 'deployed' }] : [];
			mentionMatches = extra.concat(allFiles.filter(x => (x.label.toLowerCase().includes(ql) || x.id.toLowerCase().includes(ql)) && !ctx.mentions.includes(x.id))).slice(0, 14);
		}
		mentionIdx = Math.min(mentionIdx, Math.max(0, mentionMatches.length - 1));
		mentionEl.replaceChildren(...(mentionMatches.length ? mentionMatches.map((x, i) => {
			const b = el('button', i === mentionIdx ? 'active' : ''); b.type = 'button';
			b.append(el('span', 'lbl', x.label));
			if (x.detail || KIND[x.kind]) b.append(el('span', 'det', x.detail || KIND[x.kind]));
			b.onmousedown = e => { e.preventDefault(); pickMention(x); };
			return b;
		}) : [el('div', 'empty', sq !== null ? 'No such command' : allFiles.length ? 'Nothing matches — paste a 0x… address or transaction hash' : 'Loading…')]));
		mentionEl.hidden = false;
	}
	function pickMention(x) {
		const caret = input.selectionStart;
		if (x.kind === 'command') {
			input.value = x.label + ' ' + input.value.slice(caret).trimStart();
			input.selectionStart = input.selectionEnd = x.label.length + 1;
		} else {
			const before = input.value.slice(0, caret).replace(/@[^\\s@]*$/, '');
			input.value = before + input.value.slice(caret);
			input.selectionStart = input.selectionEnd = before.length;
			labels[x.id] = x.label;
			if (!ctx.mentions.includes(x.id) && x.id !== ctx.file) ctx.mentions.push(x.id);
		}
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
				$('eyebrow').hidden = m.testnet; // only flag mainnet (real LCAI); the status bar shows the network
				$('credits').replaceChildren();
				if (m.account) { $('credits').append(m.credits ?? '—', Object.assign(document.createElement('span'), { textContent: m.credits === '1' ? ' credit' : ' credits' })); }
				else { $('credits').append(Object.assign(document.createElement('span'), { textContent: 'Connect wallet' })); }
				break;
			case 'user': {
				closeBubble();
				const u = el('div', 'lc-msg-user', m.text);
				if ((m.chips && m.chips.length) || (m.found && m.found.length)) { const cs = el('div', 'lc-msg-chips'); (m.chips || []).forEach(c => cs.append(el('span', '', c))); (m.found || []).forEach(f => { const c = el('span', 'found', f.label); c.title = 'Found in your project by local search: ' + f.title; cs.append(c); }); u.append(cs); }
				if (m.turn) {
					u.dataset.turn = m.turn;
					const edit = el('button', 'lc-msg-edit', 'Edit');
					edit.title = 'Edit and resend from here — undoes the file changes made after this message';
					edit.onclick = () => { if (!edit.disabled) { edit.disabled = true; vscode.postMessage({ type: 'rewind', turn: m.turn, text: m.text }); setTimeout(() => { edit.disabled = false; }, 2000); } };
					u.append(edit);
				}
				add(u);
				break;
			}
			case 'rewound': {
				const u = thread.querySelector('[data-turn="' + m.turn + '"]');
				if (u) { let n = u; while (n) { const next = n.nextSibling; n.remove(); n = next; } }
				current = null; lastTool = null; pending = null;
				input.value = m.text || ''; autosize(); syncSend(); input.focus();
				if (!thread.querySelector('.lc-msg-user')) { thread.replaceChildren(); if (emptyState) thread.append(emptyState); }
				break;
			}
			case 'info': closeBubble(); add(el('div', 'lc-checkpoint', m.text)); break;
			case 'checkpoint': {
				sessionEdits[m.id] = m.files; renderEdits();
				closeBubble(); clearStatus();
				const row = el('div', 'lc-checkpoint'); row.dataset.checkpoint = m.id;
				row.append(el('span', 'files', 'Changed ' + m.files.map(base).join(', ')));
				const b = smallBtn('Undo', false, () => { b.disabled = true; vscode.postMessage({ type: 'undoTurn', id: m.id }); setTimeout(() => { b.disabled = false; }, 1500); });
				b.title = 'Restore these files to how they were before this turn';
				// a contract was written: offer to deploy it straight from the chat
				if (m.files.some(f => /^src\\/.*\\.sol$/.test(f))) {
					const d = smallBtn('Deploy', false, () => vscode.postMessage({ type: 'command', command: 'lightchain.deployContract' }));
					d.title = 'Deploy a contract from this project (build, constructor arguments, confirm)';
					row.append(d);
				}
				row.append(b); add(row);
				break;
			}
			case 'checkpointUndone': {
				const row = thread.querySelector('[data-checkpoint="' + m.id + '"]');
				if (row) { row.classList.add('undone'); row.querySelector('button')?.remove(); row.append(el('span', '', 'Undone')); }
				delete sessionEdits[m.id]; renderEdits();
				break;
			}
			case 'context':
				if (m.file !== ctx.file) ctx.fileOff = false;
				ctx.file = m.file || null; ctx.selection = m.selection || null; renderChips();
				break;
			case 'files': allFiles = m.items || []; if (!mentionEl.hidden) showMentions(); break;
			case 'historyList': renderHistory(m.chats || []); break;
			case 'ai': { const b = aiBubble(); currentText = m.text || ''; b.innerHTML = render(currentText); closeBubble(); break; }
			case 'focusInput': input.focus(); break;
			case 'restoreInput': if (!input.value.trim()) { input.value = m.text; autosize(); syncSend(); } break;
			case 'delta': { if (flowIdx >= 0 && flowIdx < flowSteps.length) flowTo(flowIdx <= 1 ? 'plan' : flowSteps[flowIdx].id); const b = aiBubble(); currentText += m.text; b.innerHTML = render(currentText); scroll(); break; }
			case 'toolStart': clearStatus(); lastTool = toolCard(m.name, m.summary); if (TOOL_STEP[m.name]) flowTo(TOOL_STEP[m.name]); break;
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
			case 'approvalInEditor': approvalUi[m.id]?.inEditor(); break;
			case 'approvalResolved': approvalUi[m.id]?.done(m.ok, m.declined); break;
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
				const show = ok => {
					if (pending === decide) pending = null;
					delete approvalUi[m.id];
					const partial = ok && declined.size && declined.size < total;
					const st = el('span', 'lc-edit__state ' + (ok ? 'ok' : 'err'), ok ? (m.kind === 'command' ? 'Ran' : partial ? 'Accepted ' + (total - declined.size) + ' of ' + total : 'Accepted') : (m.kind === 'command' ? 'Skipped' : 'Rejected'));
					actions.replaceWith(st);
					box.querySelector('.lc-edit__where')?.remove();
					if (!ok) box.classList.add('done');
				};
				const decide = ok => {
					vscode.postMessage({ type: 'approve', id: m.id, ok, declined: [...declined] });
					show(ok);
				};
				approvalUi[m.id] = {
					// decided in the editor
					done: (ok, decl) => { (decl || []).forEach(h => declined.add(h)); d0()?.querySelectorAll('[data-h]').forEach(x => x.classList.toggle('declined', declined.has(Number(x.dataset.h)))); show(ok); },
					inEditor: () => { if (!box.querySelector('.lc-edit__where')) box.insertBefore(el('div', 'lc-edit__where', 'Open in the editor: accept or reject each change there, or here.'), head.nextSibling); },
				};
				const d0 = () => box.querySelector('.lc-diff');
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
			case 'turnEnd': case 'replyEnd': closeBubble(); break;
			case 'jobs': {
				closeBubble();
				const row = el('div', 'lc-jobs');
				row.append(el('span', '', 'Verified on Lightchain · ' + m.count + ' job' + (m.count === 1 ? '' : 's') + ' · ≈' + m.cost + ' LCAI'));
				m.jobs.slice(-3).forEach(j => {
					const a = el('a', '', '#' + j.id);
					if (j.url) { a.href = '#'; a.title = 'Open the job transaction on Lightscan'; a.onclick = e => { e.preventDefault(); vscode.postMessage({ type: 'openUrl', url: j.url }); }; }
					row.append(a);
				});
				add(row);
				break;
			}
			case 'status': setStatus(m.text, m.walletPrompt); break;
			case 'busy': setBusy(m.busy); if (m.busy) startFlow(); else { closeBubble(); clearStatus(); if (flowSteps.length) { flowIdx = flowSteps.length; drawFlow(true); } } break;
			case 'agents': agentState = m; renderAgent(); break;
			case 'error': card({ title: m.message, state: 'Failed', stateKind: 'err' }); break;
			case 'card': card(m); break;
			case 'cardRemove': thread.querySelector('[data-card="' + m.id + '"]')?.remove(); break;
			case 'cardUpdate': {
				const el = thread.querySelector('[data-card="' + m.id + '"]');
				if (el) fillCard(el, m); else card(m);
				break;
			}
			case 'notice': card({ title: m.message, state: 'Done', stateKind: 'ok' }); break;
			case 'cleared': thread.replaceChildren(emptyState); current = null; lastTool = null; for (const k in sessionEdits) delete sessionEdits[k]; renderEdits(); $('flowStrip').hidden = true; flowSteps = []; flowIdx = -1; break;
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
/** Chip text for an @-mention id. */
function mentionLabel(m: string): string {
	const contract = /^contract:(\w+)@/.exec(m);
	if (contract) {
		return contract[1];
	}
	const rule = /^rule:(.+)$/.exec(m);
	if (rule) {
		return rule[1];
	}
	const hex = /^(deployed|tx):(0x[0-9a-fA-F]+)$/.exec(m);
	if (hex) {
		return `${hex[1] === 'tx' ? 'tx ' : ''}${hex[2].slice(0, 6)}…${hex[2].slice(-4)}`;
	}
	return basename(m);
}

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
		case 'forge_test': return args.match ? `forge test ${args.match}` : 'forge test';
		case 'run_command': return `$ ${args.command}`;
		default: return name;
	}
}

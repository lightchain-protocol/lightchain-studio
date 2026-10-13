import * as vscode from 'vscode';

/**
 * Chat history per project and per wallet (workspaceState): each wallet sees its
 * own conversations in a project. A chat is the list of panel events
 * that can be replayed (messages, answers, tool steps, checkpoints, notes), so a
 * reload restores it exactly as it looked.
 */
export interface ChatEvent { type: string; [k: string]: unknown }
export interface Chat { id: string; title: string; updated: number; model?: string; events: ChatEvent[] }

const KEY = 'lightchain.ai.chats';
const CURRENT = 'lightchain.ai.currentChat';
const MAX_CHATS = 30;
const MAX_EVENTS = 600;

/** Event types worth keeping; everything else (status, busy, models…) is live-only. */
const REPLAYABLE = new Set(['user', 'ai', 'toolStart', 'toolEnd', 'checkpoint', 'checkpointUndone', 'info', 'notice', 'card', 'error', 'jobs']);

export class ChatStore {
	/** `wallet`: the active wallet's address (lower-case), or undefined without one. */
	constructor(private readonly state: vscode.Memento, private readonly wallet: () => string | undefined = () => undefined) { }

	private get listKey(): string {
		const w = this.wallet();
		return w ? `${KEY}:${w}` : KEY;
	}

	private get currentKey(): string {
		const w = this.wallet();
		return w ? `${CURRENT}:${w}` : CURRENT;
	}

	all(): Chat[] {
		// chats from before wallets had their own history stay visible until this wallet saves its own
		const own = this.state.get<Chat[]>(this.listKey);
		// a copy: saving this wallet's history must not change the shared one other wallets still see
		return own ?? (this.listKey === KEY ? [] : JSON.parse(JSON.stringify(this.state.get<Chat[]>(KEY, []))) as Chat[]);
	}

	current(): Chat | undefined {
		const id = this.state.get<string>(this.currentKey);
		return this.all().find(c => c.id === id);
	}

	/** Starts a new (empty, unsaved until the first event) chat. */
	async startNew(): Promise<void> {
		await this.state.update(this.currentKey, undefined);
	}

	async open(id: string): Promise<Chat | undefined> {
		const chat = this.all().find(c => c.id === id);
		if (chat) {
			await this.state.update(this.currentKey, id);
		}
		return chat;
	}

	async remove(id: string): Promise<void> {
		await this.state.update(this.listKey, this.all().filter(c => c.id !== id));
		if (this.state.get<string>(this.currentKey) === id) {
			await this.state.update(this.currentKey, undefined);
		}
	}

	/** Records one panel event into the current chat; streaming deltas merge into one answer. */
	record(msg: ChatEvent, model?: string): void {
		const type = msg.type === 'delta' ? 'ai' : msg.type;
		if (!REPLAYABLE.has(type)) {
			return;
		}
		const chats = this.all();
		let chat = chats.find(c => c.id === this.state.get<string>(this.currentKey));
		if (!chat) {
			if (type !== 'user') {
				return; // a chat starts with the user's first message
			}
			chat = { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: String(msg.text ?? 'Chat').split('\n')[0].slice(0, 80), updated: Date.now(), model, events: [] };
			chats.unshift(chat);
			void this.state.update(this.currentKey, chat.id);
		}
		const last = chat.events[chat.events.length - 1];
		if (type === 'ai' && last?.type === 'ai' && !last.closed) {
			last.text = String(last.text ?? '') + String(msg.text ?? '');
		} else if (msg.type === 'turnEnd') {
			// nothing: turnEnd closes the open answer below
		} else {
			chat.events.push(type === 'ai' ? { type: 'ai', text: msg.text } : { ...msg });
		}
		if (chat.events.length > MAX_EVENTS) {
			chat.events.splice(0, chat.events.length - MAX_EVENTS);
		}
		chat.updated = Date.now();
		chat.model = model ?? chat.model;
		// newest first, capped
		const ordered = [chat, ...chats.filter(c => c.id !== chat!.id)].slice(0, MAX_CHATS);
		void this.state.update(this.listKey, ordered);
	}

	/** Drops the user message of `turn` and everything after it from the current chat. */
	rewind(turn: string): void {
		const chats = this.all();
		const chat = chats.find(c => c.id === this.state.get<string>(this.currentKey));
		const at = chat?.events.findIndex(e => e.type === 'user' && e.turn === turn) ?? -1;
		if (chat && at >= 0) {
			chat.events.splice(at);
			void this.state.update(this.listKey, chats);
		}
	}

	/** Ends the current streamed answer so the next delta starts a new one. */
	closeAnswer(): void {
		const chats = this.all();
		const chat = chats.find(c => c.id === this.state.get<string>(this.currentKey));
		const last = chat?.events[chat.events.length - 1];
		if (last?.type === 'ai') {
			last.closed = true;
			void this.state.update(this.listKey, chats);
		}
	}

	/** A short recap of a chat for a new worker session (it does not see the old one). */
	static summary(chat: Chat, turns = 6): string {
		const parts: string[] = [];
		for (const e of chat.events) {
			if (e.type === 'user') {
				parts.push(`User: ${String(e.text).slice(0, 500)}`);
			} else if (e.type === 'ai' && String(e.text ?? '').trim()) {
				parts.push(`Assistant: ${String(e.text).replace(/```tool[\s\S]*?```/g, '').trim().slice(0, 600)}`);
			} else if (e.type === 'checkpoint') {
				parts.push(`(files changed: ${(e.files as string[]).join(', ')})`);
			}
		}
		return parts.slice(-turns * 2).join('\n');
	}
}

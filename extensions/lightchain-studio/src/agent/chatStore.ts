import * as vscode from 'vscode';

/**
 * Chat history per project (workspaceState). A chat is the list of panel events
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
	constructor(private readonly state: vscode.Memento) { }

	all(): Chat[] {
		return this.state.get<Chat[]>(KEY, []);
	}

	current(): Chat | undefined {
		const id = this.state.get<string>(CURRENT);
		return this.all().find(c => c.id === id);
	}

	/** Starts a new (empty, unsaved until the first event) chat. */
	async startNew(): Promise<void> {
		await this.state.update(CURRENT, undefined);
	}

	async open(id: string): Promise<Chat | undefined> {
		const chat = this.all().find(c => c.id === id);
		if (chat) {
			await this.state.update(CURRENT, id);
		}
		return chat;
	}

	async remove(id: string): Promise<void> {
		await this.state.update(KEY, this.all().filter(c => c.id !== id));
		if (this.state.get<string>(CURRENT) === id) {
			await this.state.update(CURRENT, undefined);
		}
	}

	/** Records one panel event into the current chat; streaming deltas merge into one answer. */
	record(msg: ChatEvent, model?: string): void {
		const type = msg.type === 'delta' ? 'ai' : msg.type;
		if (!REPLAYABLE.has(type)) {
			return;
		}
		const chats = this.all();
		let chat = chats.find(c => c.id === this.state.get<string>(CURRENT));
		if (!chat) {
			if (type !== 'user') {
				return; // a chat starts with the user's first message
			}
			chat = { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: String(msg.text ?? 'Chat').split('\n')[0].slice(0, 80), updated: Date.now(), model, events: [] };
			chats.unshift(chat);
			void this.state.update(CURRENT, chat.id);
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
		void this.state.update(KEY, ordered);
	}

	/** Drops the user message of `turn` and everything after it from the current chat. */
	rewind(turn: string): void {
		const chats = this.all();
		const chat = chats.find(c => c.id === this.state.get<string>(CURRENT));
		const at = chat?.events.findIndex(e => e.type === 'user' && e.turn === turn) ?? -1;
		if (chat && at >= 0) {
			chat.events.splice(at);
			void this.state.update(KEY, chats);
		}
	}

	/** Ends the current streamed answer so the next delta starts a new one. */
	closeAnswer(): void {
		const chats = this.all();
		const chat = chats.find(c => c.id === this.state.get<string>(CURRENT));
		const last = chat?.events[chat.events.length - 1];
		if (last?.type === 'ai') {
			last.closed = true;
			void this.state.update(KEY, chats);
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

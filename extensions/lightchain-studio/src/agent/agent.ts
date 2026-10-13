import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TOOLS, ToolCall, ToolContext, ToolResult } from './tools';
import { AgentProfile, allowedTools, profilePrompt } from './profiles';

/**
 * Lightchain AI coding agent.
 *
 * Lightchain models have no native function calling, so tools use a text
 * protocol: the model writes fenced blocks
 *
 *   ```tool
 *   {"name": "write_file", "args": {"path": "src/Token.sol", "content": "..."}}
 *   ```
 *
 * The agent parses them, runs each tool (writes/commands need user approval),
 * appends results to the conversation and loops until the model answers
 * without tool calls (or the step budget runs out).
 */
/** `request`: on the user's own prompts, their words without the attached context. */
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; request?: string; /** system message: the project map */ map?: string }

/** A model provider — Lightchain inference by default. */
export interface InferenceProvider {
	readonly name: string;
	chat(messages: ChatMessage[], signal: AbortSignal, onStatus?: (status: string, opts?: { walletPrompt?: boolean }) => void): AsyncIterable<string>;
}

export interface AgentEvents {
	onText(delta: string): void;
	onToolStart(call: ToolCall): void;
	/** `soft`: a slip by the model it is told to correct (not shown to the user as a failure). */
	onToolEnd(call: ToolCall, result: ToolResult, soft?: boolean): void;
	onTurnEnd(): void;
	/** One model reply finished (a turn can have several, between tool steps). */
	onReplyEnd?(): void;
	onStatus(status: string, opts?: { walletPrompt?: boolean }): void;
}

const MAX_STEPS = 12;
const TOOL_BLOCK = /```tool\s*\n([\s\S]*?)\n```/g;

/**
 * Tools offered to the model. No partial edits: models reliably get "find this exact
 * text" wrong, so a change is always read_file → write_file with the complete content
 * (the user still approves it as a diff).
 */
const AGENT_TOOLS = TOOLS.filter(t => t.name !== 'edit_file');

export function systemPrompt(workspaceName: string, profile?: AgentProfile): string {
	const allowed = profile ? allowedTools(profile) : undefined;
	const tools = AGENT_TOOLS.filter(t => !allowed || allowed.includes(t.name)).map(t => `- ${t.name}: ${t.description}\n  args: ${t.args}`).join('\n');
	const canWrite = !profile || profile.can.write;
	return [
		`You are Lightchain AI, the coding agent inside Lightchain Studio — the IDE for building on the Lightchain AI blockchain (EVM, Solidity, Foundry). Testnet chain id 8200, mainnet 9200. LCAI is the chain's native coin, like ETH on Ethereum: contracts receive it with payable functions and msg.value and send it with call{value: …} — never treat LCAI as an ERC-20 token.`,
		`You are working in the project "${workspaceName}". Paths are relative to the project root.`,
		...(profile ? ['', profilePrompt(profile)] : []),
		``,
		`You can use tools. To call one, reply with a fenced block exactly like:`,
		'```tool',
		`{"name": "read_file", "args": {"path": "src/Counter.sol"}}`,
		'```',
		`Call one or more tools per reply, then STOP and wait for the results. Do not invent tool results.`,
		`Replies are limited to about 3,000 characters (roughly 60 lines of code). Write ONE file per reply. A longer file is written in parts: write_file the first ~50 lines (stop at the end of a function), then append_file the next ~50 lines, and so on until the file is complete — never try to send a long file in one reply.`,
		`When the task is done, reply normally without any tool block and summarize ${canWrite ? 'what you changed' : 'your answer'}.`,
		``,
		`Tools:`,
		tools,
		...(canWrite ? [
			``,
			`Example — to create a file, reply with:`,
			'```tool',
			`{"name": "write_file", "args": {"path": "src/Hello.sol", "content": "// SPDX-License-Identifier: MIT\\npragma solidity ^0.8.24;\\n\\ncontract Hello {}\\n"}}`,
			'```',
			``,
			`Rules: a file only exists after a write_file result says "Wrote …" — never claim you created or changed a file otherwise. To change a file, read_file it, then write_file the COMPLETE new file (never a fragment); write complete, compilable Solidity (pragma ^0.8.24, SPDX header); prefer Foundry conventions (src/, test/, script/); keep changes minimal and explain them briefly.`,
		] : []),
	].join('\n');
}

const ANY_BLOCK = /```([\w+-]*)[^\n]*\n([\s\S]*?)\n```/g;
const PATH_HINT = /`?((?:[\w.-]+\/)*[\w.-]+\.(?:sol|t\.sol|s\.sol|ts|js|json|toml|md|yaml|yml))`?/g;

export function parseToolCalls(text: string): ToolCall[] {
	const calls: ToolCall[] = [];
	// ```json blocks that are clearly tool calls ({"name": ..., "args": ...})
	for (const m of text.matchAll(ANY_BLOCK)) {
		if (m[1] === 'tool' || !/^json$/i.test(m[1])) {
			continue;
		}
		try {
			const parsed = JSON.parse(m[2].trim());
			if (parsed && typeof parsed.name === 'string' && parsed.args && typeof parsed.args === 'object') {
				calls.push({ name: parsed.name, args: parsed.args });
			}
		} catch { /* ordinary JSON example */ }
	}
	for (const m of text.matchAll(TOOL_BLOCK)) {
		try {
			const parsed = JSON.parse(m[1].trim());
			if (parsed && typeof parsed.name === 'string') {
				calls.push({ name: parsed.name, args: parsed.args ?? {} });
			}
		} catch {
			calls.push({ name: '__invalid__', args: { raw: m[1].slice(0, 400) } });
		}
	}
	return calls;
}

/**
 * Small models often answer with a code block and a file name instead of calling
 * write_file. Turn the first such block into a write_file proposal (the user still
 * approves it with a diff). Returns undefined when nothing applies.
 */
export function codeBlockAsWrite(text: string): ToolCall | undefined {
	for (const m of text.matchAll(ANY_BLOCK)) {
		const lang = m[1].toLowerCase();
		if (!lang || lang === 'tool' || lang === 'json' || lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === 'console') {
			continue;
		}
		const before = text.slice(Math.max(0, (m.index ?? 0) - 300), m.index ?? 0);
		const paths = [...before.matchAll(PATH_HINT)].map(p => p[1]);
		const firstLine = m[2].split('\n')[0];
		const inline = /(?:\/\/|#)\s*((?:[\w.-]+\/)*[\w.-]+\.\w+)\s*$/.exec(firstLine)?.[1];
		const path = inline ?? paths[paths.length - 1];
		if (path && m[2].trim().length > 20) {
			return { name: 'write_file', args: { path, content: m[2].endsWith('\n') ? m[2] : m[2] + '\n' } };
		}
	}
	return undefined;
}

/**
 * Lightchain workers cap an answer at about 1,000 tokens, so a reply that writes a
 * whole file is often cut in the middle of its tool block. True when `text` ends
 * inside a ```tool (or tool-call ```json) block that was never closed.
 */
export function cutOffToolCall(text: string): boolean {
	const fences = [...text.matchAll(/^```([\w+-]*)[^\n]*$/gm)];
	if (fences.length % 2 === 0) {
		return false; // every block is closed
	}
	const open = fences[fences.length - 1];
	const body = text.slice(open.index! + open[0].length);
	return open[1] === 'tool' || (/^json$/i.test(open[1]) && /"name"\s*:/.test(body)) || /"name"\s*:\s*"write_file"/.test(body);
}

/** Joins a cut-off reply with its continuation: drops a repeated code fence and any overlap the model repeated. */
export function joinContinuation(head: string, more: string): string {
	let tail = more.replace(/^\s*```[\w+-]*[^\n]*\n/, '').replace(/^\s*(?:Continuing|Here is the rest|Continued)[^\n]*\n+/i, '');
	// the model often repeats the last few characters it had already written
	for (let n = Math.min(200, head.length, tail.length); n >= 12; n--) {
		if (head.endsWith(tail.slice(0, n))) {
			tail = tail.slice(n);
			break;
		}
	}
	return head + tail;
}

/** "I have created `src/Game.sol`…" → "src/Game.sol" (a claim of a file change), else undefined. */
export function claimedFile(text: string): string | undefined {
	if (!/\b(I(?:'ve| have)?\s+(?:now\s+)?(?:created|written|wrote|added|updated|modified|saved|implemented)|has been (?:created|written|added|updated|saved))\b/i.test(text)) {
		return undefined;
	}
	return /`?((?:[\w.-]+\/)*[\w-]+\.(?:t\.sol|s\.sol|sol|ts|js|json|toml|md))`?/.exec(text)?.[1];
}

/** Whether the project has Foundry tests (.t.sol files under test/). */
function hasTests(root: string): boolean {
	const walk = (dir: string, depth: number): boolean => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return false;
		}
		return entries.some(e => e.isFile() ? e.name.endsWith('.t.sol') : e.isDirectory() && depth < 4 && walk(path.join(dir, e.name), depth + 1));
	};
	return walk(path.join(root, 'test'), 0);
}

/** The model kept failing its tool calls; stopped so it doesn't spend credits in a loop. */
export class AgentStuckError extends Error { }

const MAX_FAILED_STEPS = 3;
const MAX_FIX_ROUNDS = 2;
/** How many times one answer may be continued after the worker cut it off. */
const MAX_CONTINUES = 1;

export class Agent {
	private history: ChatMessage[];
	/** The latest forge build / forge test of the running or last turn (undefined: none ran). */
	lastCheck?: { command: string; ok: boolean; output: string };

	constructor(private provider: InferenceProvider, private readonly ctx: ToolContext, private profile?: AgentProfile) {
		this.history = [{ role: 'system', content: systemPrompt(vscode.workspace.name ?? 'workspace', profile) }];
	}

	/** Switch to another agent profile; takes effect with the next worker session. */
	setProfile(profile: AgentProfile): void {
		this.profile = profile;
		this.history[0] = { ...this.history[0], content: systemPrompt(vscode.workspace.name ?? 'workspace', profile) };
	}

	private get tools() {
		const allowed = this.profile ? allowedTools(this.profile) : undefined;
		return AGENT_TOOLS.filter(t => !allowed || allowed.includes(t.name));
	}

	/** The current project map; sent at the start of a session and again when it changes. */
	setProjectMap(map: string): void {
		this.history[0].map = map || undefined;
	}

	/** The model's latest reply (without tool results). */
	lastReply(): string {
		for (let i = this.history.length - 1; i > 0; i--) {
			if (this.history[i].role === 'assistant') {
				return this.history[i].content;
			}
		}
		return '';
	}

	/** Number of messages so far (a mark to rewind to). */
	get size(): number {
		return this.history.length;
	}

	/** Forget everything after `mark` (the session must be replaced: the worker still has it). */
	truncate(mark: number): void {
		this.history.length = Math.max(1, Math.min(mark, this.history.length));
	}

	/** Continue the same conversation on another model or worker session. */
	setProvider(provider: InferenceProvider): void {
		this.provider = provider;
	}

	reset(): void {
		this.history = this.history.slice(0, 1);
	}

	async run(userText: string, events: AgentEvents, signal: AbortSignal, request?: string): Promise<void> {
		const mark = this.history.length;
		this.lastCheck = undefined;
		try {
			await this.loop(userText, events, signal, request ?? userText);
		} catch (err) {
			if (this.history.length === mark + 1) {
				this.history.length = mark; // nothing was answered: forget the prompt so it can be retried
			}
			throw err;
		}
	}

	private async loop(userText: string, events: AgentEvents, signal: AbortSignal, request: string): Promise<void> {
		this.history.push({ role: 'user', content: userText, request });
		let wrote = false;   // a write_file/edit_file ran this turn
		let failedSteps = 0; // consecutive steps where every tool call failed
		let nudged = false;  // already told the model to actually write
		let unbuilt = false; // .sol files written since the last successful build
		let fixRounds = 0;   // automatic "fix the build" rounds this turn
		for (let step = 0; step < MAX_STEPS && !signal.aborted; step++) {
			let reply = '';
			for await (const delta of this.provider.chat(this.history, signal, (st, o) => events.onStatus(st, o))) {
				reply += delta;
				events.onText(delta);
			}
			// the worker cut the answer in the middle of a tool call: have the model carry on from that exact point
			for (let n = 0; n < MAX_CONTINUES && cutOffToolCall(reply) && !signal.aborted; n++) {
				events.onStatus(`The answer was cut off by the network's length limit — continuing it (${n + 1})…`);
				this.history.push({ role: 'assistant', content: reply });
				this.history.push({ role: 'user', content: 'Your reply was cut off by the length limit in the middle of the tool block. Continue EXACTLY from the character where it stopped: no repetition, no explanation, no new code fence. Finish the JSON and close the block with ```.' });
				let more = '';
				for await (const delta of this.provider.chat(this.history, signal, (st, o) => events.onStatus(st, o))) {
					more += delta; // the rest of a tool block: nothing to show the user
				}
				// keep one assistant message holding the whole reply
				this.history.length -= 2;
				reply = joinContinuation(reply, more);
			}
			events.onReplyEnd?.();
			this.history.push({ role: 'assistant', content: reply });
			const calls = parseToolCalls(reply);
			if (!calls.length && cutOffToolCall(reply)) {
				// still unfinished after the allowed continuations: say so instead of ending as if nothing was asked
				this.history.push({ role: 'user', content: 'That file is too long to send in one reply, so nothing was written. Write it in parts instead: call write_file now with ONLY the first 40 to 50 lines (stop at the end of a function), then in your next replies call append_file with the next 40 to 50 lines each, until the file is complete.' });
				events.onStatus('The file was too long for one answer — asking for it in smaller parts…');
				if (step < MAX_STEPS - 1) {
					continue;
				}
			}
			if (!calls.length) {
				const apply = this.profile && !this.profile.can.write ? undefined : codeBlockAsWrite(reply);
				if (!apply) {
					// Small models often say they created a file without calling write_file.
					const claimed = this.profile && !this.profile.can.write ? undefined : claimedFile(reply);
					if (claimed && !wrote && !nudged) {
						nudged = true;
						events.onStatus(`The model described ${claimed} without writing it — asking it to write the file…`);
						this.history.push({ role: 'user', content: `You said you created or changed ${claimed}, but no write_file call was made, so nothing changed. Call write_file now with the complete file content, using a tool block.` });
						continue;
					}
					// Build-and-fix: compile what was written; feed errors back (max 2 rounds).
					if (unbuilt && this.ctx.forgePath && !signal.aborted && (!this.profile || (this.profile.check && this.profile.can.build))) {
						const build = TOOLS.find(t => t.name === 'forge_build')!;
						const call: ToolCall = { name: 'forge_build', args: {} };
						events.onToolStart(call);
						const result = await build.run({}, this.ctx).catch(err => ({ ok: false, output: (err as Error).message }));
						events.onToolEnd(call, result);
						this.lastCheck = { command: 'forge build', ...result };
						unbuilt = !result.ok;
						if (!result.ok && fixRounds < MAX_FIX_ROUNDS) {
							fixRounds++;
							events.onStatus(`Build failed — Lightchain AI is fixing it (attempt ${fixRounds} of ${MAX_FIX_ROUNDS})…`);
							this.history.push({ role: 'user', content: `forge build failed:\n${result.output.slice(0, 4000)}\n\nFix every error: read_file the affected file(s), then write_file each with its complete corrected content.` });
							continue;
						}
						// it builds: run the project's tests too, and fix what broke
						if (result.ok && hasTests(this.ctx.root) && !signal.aborted && (!this.profile || this.profile.can.test)) {
							const test = TOOLS.find(t => t.name === 'forge_test')!;
							const tcall: ToolCall = { name: 'forge_test', args: {} };
							events.onToolStart(tcall);
							const tres = await test.run({}, this.ctx).catch(err => ({ ok: false, output: (err as Error).message }));
							events.onToolEnd(tcall, tres);
							this.lastCheck = { command: 'forge test', ...tres };
							if (!tres.ok && fixRounds < MAX_FIX_ROUNDS) {
								fixRounds++;
								unbuilt = true; // check again after the fix
								events.onStatus(`Tests failed — Lightchain AI is fixing it (attempt ${fixRounds} of ${MAX_FIX_ROUNDS})…`);
								this.history.push({ role: 'user', content: `forge test failed:\n${tres.output.slice(-4000)}\n\nFix the failures. Decide whether the test or the code is wrong and say which; read_file, then write_file the complete corrected file.` });
								continue;
							}
						}
					}
					break;
				}
				calls.push(apply); // still goes through the approval gate with a diff
			}
			const results: string[] = [];
			for (const call of calls) {
				if (signal.aborted) {
					break;
				}
				const tool = this.tools.find(t => t.name === call.name);
				if (!tool) {
					// a slip the model corrects itself: tell it, don't show it as a failed step
					const output = call.name === 'edit_file'
						? `edit_file is not available. Call read_file on ${String(call.args.path ?? 'the file')} if needed, then write_file with its complete new content.`
						: call.name === '__invalid__' ? 'Invalid tool JSON — use {"name": ..., "args": {...}} inside a ```tool block.' : `Tool "${call.name}" is not available to this agent. Available: ${this.tools.map(t => t.name).join(', ')}.`;
					events.onToolEnd(call, { ok: false, output }, true);
					if (!results.some(r => r.includes(output))) {
						results.push(`Result of ${call.name} (error):\n${output}`);
					}
					continue;
				}
				events.onToolStart(call);
				const result: ToolResult = await tool.run(call.args, this.ctx).catch(err => ({ ok: false, output: (err as Error).message }));
				events.onToolEnd(call, result);
				if (result.ok && (call.name === 'write_file' || call.name === 'append_file')) {
					wrote = true;
					if (/\.sol$/.test(String(call.args.path ?? ''))) {
						unbuilt = true;
					}
				}
				if (call.name === 'forge_build') {
					unbuilt = !result.ok;
				}
				if (call.name === 'forge_build' || call.name === 'forge_test') {
					this.lastCheck = { command: call.name.replace('_', ' '), ok: result.ok, output: result.output };
				}
				results.push(`Result of ${call.name}${result.ok ? '' : ' (error)'}:\n${result.output}`);
			}
			failedSteps = results.length && results.every(r => r.includes(' (error):')) ? failedSteps + 1 : 0;
			if (failedSteps >= MAX_FAILED_STEPS) {
				this.history.push({ role: 'user', content: results.join('\n\n') });
				throw new AgentStuckError(`Stopped after ${MAX_FAILED_STEPS} failed attempts in a row, so it doesn't keep spending credits.`);
			}
			this.history.push({ role: 'user', content: results.join('\n\n') });
		}
		// Out of steps (or stopped by a failure) with contract changes nobody compiled: check them once,
		// so the user is told when the result does not build instead of being offered a deploy.
		if (unbuilt && this.ctx.forgePath && !signal.aborted && (!this.profile || this.profile.can.build)) {
			const call: ToolCall = { name: 'forge_build', args: {} };
			events.onToolStart(call);
			const result = await TOOLS.find(t => t.name === 'forge_build')!.run({}, this.ctx).catch(err => ({ ok: false, output: (err as Error).message }));
			this.lastCheck = { command: 'forge build', ...result };
			events.onToolEnd(call, result);
		}
		events.onTurnEnd();
	}
}

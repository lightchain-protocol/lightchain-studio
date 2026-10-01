import * as vscode from 'vscode';
import { TOOLS, ToolCall, ToolContext, ToolResult } from './tools';

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
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

/** A model provider — Lightchain inference by default. */
export interface InferenceProvider {
	readonly name: string;
	chat(messages: ChatMessage[], signal: AbortSignal, onStatus?: (status: string, opts?: { walletPrompt?: boolean }) => void): AsyncIterable<string>;
}

export interface AgentEvents {
	onText(delta: string): void;
	onToolStart(call: ToolCall): void;
	onToolEnd(call: ToolCall, result: ToolResult): void;
	onTurnEnd(): void;
	onStatus(status: string, opts?: { walletPrompt?: boolean }): void;
}

const MAX_STEPS = 12;
const TOOL_BLOCK = /```tool\s*\n([\s\S]*?)\n```/g;

export function systemPrompt(workspaceName: string): string {
	const tools = TOOLS.map(t => `- ${t.name}: ${t.description}\n  args: ${t.args}`).join('\n');
	return [
		`You are Lightchain AI, the coding agent inside Lightchain Studio — the IDE for building on the Lightchain AI blockchain (EVM, Solidity, Foundry). Testnet chain id 8200, mainnet 9200, native token LCAI.`,
		`You are working in the project "${workspaceName}". Paths are relative to the project root.`,
		``,
		`You can use tools. To call one, reply with a fenced block exactly like:`,
		'```tool',
		`{"name": "read_file", "args": {"path": "src/Counter.sol"}}`,
		'```',
		`Call one or more tools per reply, then STOP and wait for the results. Do not invent tool results.`,
		`When the task is done, reply normally without any tool block and summarize what you changed.`,
		``,
		`Tools:`,
		tools,
		``,
		`Example — to create a file, reply with:`,
		'```tool',
		`{"name": "write_file", "args": {"path": "src/Hello.sol", "content": "// SPDX-License-Identifier: MIT\\npragma solidity ^0.8.24;\\n\\ncontract Hello {}\\n"}}`,
		'```',
		``,
		`Rules: a file only exists after a write_file result says "Wrote …" — never claim you created or changed a file otherwise. Read files before editing them; write complete, compilable Solidity (pragma ^0.8.24, SPDX header); prefer Foundry conventions (src/, test/, script/); keep changes minimal and explain them briefly.`,
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

export class Agent {
	private history: ChatMessage[];

	constructor(private readonly provider: InferenceProvider, private readonly ctx: ToolContext) {
		this.history = [{ role: 'system', content: systemPrompt(vscode.workspace.name ?? 'workspace') }];
	}

	reset(): void {
		this.history = this.history.slice(0, 1);
	}

	async run(userText: string, events: AgentEvents, signal: AbortSignal): Promise<void> {
		const mark = this.history.length;
		try {
			await this.loop(userText, events, signal);
		} catch (err) {
			if (this.history.length === mark + 1) {
				this.history.length = mark; // nothing was answered: forget the prompt so it can be retried
			}
			throw err;
		}
	}

	private async loop(userText: string, events: AgentEvents, signal: AbortSignal): Promise<void> {
		this.history.push({ role: 'user', content: userText });
		for (let step = 0; step < MAX_STEPS && !signal.aborted; step++) {
			let reply = '';
			for await (const delta of this.provider.chat(this.history, signal, (st, o) => events.onStatus(st, o))) {
				reply += delta;
				events.onText(delta);
			}
			this.history.push({ role: 'assistant', content: reply });
			const calls = parseToolCalls(reply);
			if (!calls.length) {
				const apply = codeBlockAsWrite(reply);
				if (!apply) {
					break;
				}
				calls.push(apply); // still goes through the approval gate with a diff
			}
			const results: string[] = [];
			for (const call of calls) {
				if (signal.aborted) {
					break;
				}
				events.onToolStart(call);
				const tool = TOOLS.find(t => t.name === call.name);
				const result: ToolResult = tool
					? await tool.run(call.args, this.ctx).catch(err => ({ ok: false, output: (err as Error).message }))
					: { ok: false, output: call.name === '__invalid__' ? 'Invalid tool JSON — use {"name": ..., "args": {...}}.' : `Unknown tool "${call.name}".` };
				events.onToolEnd(call, result);
				results.push(`Result of ${call.name}${result.ok ? '' : ' (error)'}:\n${result.output}`);
			}
			this.history.push({ role: 'user', content: results.join('\n\n') });
		}
		events.onTurnEnd();
	}
}

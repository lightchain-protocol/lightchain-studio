import type { ChatMessage } from './agent';

/**
 * Keeping a conversation alive on Lightchain.
 *
 * The worker replays every earlier job of the session, but the model's context
 * window is small and the oldest turns (our instructions first) fall out of it.
 * So: every prompt carries short session notes, and when a session grows past
 * its budget the next prompt opens a fresh session seeded with a recap.
 * Everything here is derived from the local history — no extra jobs, no credits.
 */

/** Rough token estimate (≈4 characters per token for code and English). */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

const TOOL_BLOCK = /```(?:tool|json)[^\n]*\n[\s\S]*?```/g;

/** Files the agent wrote in this conversation, oldest first. */
export function changedFiles(history: ChatMessage[]): string[] {
	const files: string[] = [];
	for (const m of history) {
		if (m.role === 'user' && !m.request) {
			for (const hit of m.content.matchAll(/^Wrote (\S+?)\.?(?=\s|$)/gm)) {
				if (!files.includes(hit[1])) {
					files.push(hit[1]);
				}
			}
		}
	}
	return files;
}

function lastRequest(history: ChatMessage[]): string | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		if (history[i].request) {
			return history[i].request;
		}
	}
	return undefined;
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/**
 * A few lines sent with every prompt after the first of a session, so the task,
 * the files touched and the tool rules survive even when early turns are dropped.
 */
export function sessionNotes(history: ChatMessage[]): string {
	const task = lastRequest(history);
	const files = changedFiles(history);
	return [
		'[Session notes]',
		...(task ? [`Current task: ${oneLine(task, 240)}`] : []),
		...(files.length ? [`Files changed so far: ${files.slice(-12).join(', ')}`] : []),
		'Reminder: call tools with a ```tool block ({"name": …, "args": …}); read_file before changing a file; write_file needs the COMPLETE file.',
	].join('\n');
}

/**
 * The conversation so far, compressed for a new session: the user's requests,
 * short answers (tool calls removed) and one line per tool result — newest kept
 * when it does not all fit in `maxChars`.
 */
export function recap(history: ChatMessage[], maxChars = 3_500): string {
	const lines: string[] = [];
	for (const m of history) {
		if (m.role === 'system') {
			continue;
		}
		if (m.role === 'user' && m.request) {
			lines.push(`User: ${oneLine(m.request, 400)}`);
		} else if (m.role === 'assistant') {
			const said = oneLine(m.content.replace(TOOL_BLOCK, ''), 300);
			const tools = [...m.content.matchAll(/"name"\s*:\s*"(\w+)"[^}]*?"path"\s*:\s*"([^"]+)"/g)].map(t => `${t[1]} ${t[2]}`);
			if (said || tools.length) {
				lines.push(`You: ${said}${tools.length ? ` [${tools.join('; ')}]` : ''}`.trim());
			}
		} else {
			const results = [...m.content.matchAll(/^Result of (\w+)( \(error\))?:\n(.*)$/gm)].map(r => `${r[1]}${r[2] ? ' failed' : ''}: ${oneLine(r[3], 100)}`);
			if (results.length) {
				lines.push(`Results: ${results.join('; ')}`);
			} else if (m.content.trim()) {
				lines.push(`Note: ${oneLine(m.content, 160)}`);
			}
		}
	}
	const kept: string[] = [];
	let size = 0;
	for (let i = lines.length - 1; i >= 0 && size + lines[i].length <= maxChars; i--) {
		kept.unshift(lines[i]);
		size += lines[i].length + 1;
	}
	const files = changedFiles(history);
	return [
		...(kept.length < lines.length ? ['(earlier turns omitted)'] : []),
		...kept,
		...(files.length ? [`Files changed in this conversation: ${files.join(', ')} — read_file them before changing them again.`] : []),
	].join('\n');
}

import { ChatMessage, InferenceProvider } from './agent';
import type { StatusFn } from '../lightchain/inference';

/**
 * Inline edit (⌘I): rewrite one range of a file from an instruction. A single
 * model call — no tools — returning only the replacement code.
 */
const SYSTEM = [
	'You are Lightchain AI inside Lightchain Studio, editing code in place.',
	'You get a file, a marked range of it and an instruction. Rewrite ONLY the marked range so it follows the instruction.',
	'Reply with the complete replacement for the marked range in ONE fenced code block and nothing else.',
	'Keep the surrounding code compiling, match the file\'s style and indentation, do not repeat code outside the range.',
].join('\n');

export interface InlineEditRequest { file: string; language: string; text: string; startLine: number; endLine: number; instruction: string }

export function buildInlinePrompt(r: InlineEditRequest): ChatMessage[] {
	const lines = r.text.split('\n');
	const numbered = lines.map((l, i) => `${String(i + 1).padStart(4)}${i + 1 >= r.startLine && i + 1 <= r.endLine ? ' >' : '  '} ${l}`).join('\n');
	const range = lines.slice(r.startLine - 1, r.endLine).join('\n');
	return [
		{ role: 'system', content: SYSTEM },
		{ role: 'user', content: `File ${r.file} (lines marked ">" are the range to rewrite):\n\`\`\`\n${numbered.slice(0, 20_000)}\n\`\`\`\n\nThe marked range, exactly:\n\`\`\`${r.language}\n${range}\n\`\`\`\n\nInstruction: ${r.instruction}` },
	];
}

/** The replacement code from the model's reply (first fenced block, else the whole reply). */
export function extractReplacement(reply: string): string | undefined {
	const m = /```[\w+-]*[^\n]*\n([\s\S]*?)\n?```/.exec(reply);
	const code = (m ? m[1] : reply).replace(/\s+$/, '');
	return code.trim() ? code : undefined;
}

export async function runInlineEdit(provider: InferenceProvider, r: InlineEditRequest, signal: AbortSignal, onStatus?: StatusFn): Promise<string | undefined> {
	let reply = '';
	for await (const delta of provider.chat(buildInlinePrompt(r), signal, onStatus)) {
		reply += delta;
	}
	return extractReplacement(reply);
}

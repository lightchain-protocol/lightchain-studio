/**
 * Markdown files with a small front matter block, the format agents and
 * instructions are stored in (.lightchain/agents/*.md, .lightchain/rules/*.md):
 *
 *   ---
 *   name: Gas Optimizer
 *   tools: [read, build]
 *   starters:
 *     - Where does this contract waste gas?
 *   ---
 *   Free text…
 *
 * Only what those files need: `key: value` pairs with strings, booleans and
 * lists (inline `[a, b]` or one `- item` per line).
 */
export type FrontValue = string | boolean | string[];
export interface FrontDoc { data: Record<string, FrontValue>; body: string }

function unquote(s: string): string {
	const t = s.trim();
	if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('\'') && t.endsWith('\'')))) {
		return t.startsWith('"') ? t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : t.slice(1, -1).replace(/''/g, '\'');
	}
	return t;
}

/** Splits `a, "b, c", d` on the commas outside quotes. */
function splitList(s: string): string[] {
	const out: string[] = [];
	let cur = '';
	let quote = '';
	for (const ch of s) {
		if (quote) {
			cur += ch;
			quote = ch === quote ? '' : quote;
		} else if (ch === '"' || ch === '\'') {
			quote = ch;
			cur += ch;
		} else if (ch === ',') {
			out.push(cur);
			cur = '';
		} else {
			cur += ch;
		}
	}
	out.push(cur);
	return out.map(unquote).filter(Boolean);
}

export function parseFrontMatter(text: string): FrontDoc {
	const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
	const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
	if (!m) {
		return { data: {}, body: src.trim() };
	}
	const data: Record<string, FrontValue> = {};
	let listKey: string | undefined;
	for (const line of m[1].split('\n')) {
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item && listKey) {
			const list = Array.isArray(data[listKey]) ? data[listKey] as string[] : (data[listKey] = []);
			list.push(unquote(item[1]));
			continue;
		}
		const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!kv) {
			continue; // comments, blank lines, anything we don't understand
		}
		const key = kv[1];
		// a trailing "# comment" is not part of the value (quoted values keep theirs)
		const raw = /^["']/.test(kv[2].trim()) ? kv[2].trim() : kv[2].replace(/\s+#.*$/, '').trim();
		listKey = undefined;
		if (!raw) {
			data[key] = ''; // becomes a list when "- item" lines follow
			listKey = key;
		} else if (raw.startsWith('[') && raw.endsWith(']')) {
			data[key] = splitList(raw.slice(1, -1));
		} else if (raw === 'true' || raw === 'false') {
			data[key] = raw === 'true';
		} else {
			data[key] = unquote(raw);
		}
	}
	return { data, body: src.slice(m[0].length).trim() };
}

function scalar(s: string): string {
	// quote what YAML would read as something else
	return s === '' || /^[\s#\-?:,[\]{}&*!|>'"%@`]|:\s|\s#|\s$|^(true|false|null|yes|no|~|[\d.+-]+)$/i.test(s) ? JSON.stringify(s) : s;
}

export function formatFrontMatter(data: Record<string, FrontValue | undefined>, body: string): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) {
			continue;
		}
		if (Array.isArray(value)) {
			const short = value.every(v => /^[\w.*/{}-]+$/.test(v)) && value.join(', ').length <= 60;
			if (short) {
				lines.push(`${key}: [${value.join(', ')}]`);
			} else {
				lines.push(`${key}:`, ...value.map(v => `  - ${scalar(v)}`));
			}
		} else {
			lines.push(`${key}: ${typeof value === 'boolean' ? String(value) : scalar(value)}`);
		}
	}
	return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`;
}

/** "Gas Optimizer!" → "gas-optimizer" (a file name and id). */
export function slug(name: string, fallback = 'item'): string {
	return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;
}

/** `slug`, made unique among `taken` with -2, -3… */
export function uniqueSlug(name: string, taken: Iterable<string>, fallback = 'item'): string {
	const used = new Set(taken);
	const base = slug(name, fallback);
	let id = base;
	for (let n = 2; used.has(id); n++) {
		id = `${base}-${n}`;
	}
	return id;
}

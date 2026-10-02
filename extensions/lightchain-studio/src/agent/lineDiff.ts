/** A diff line: ' ' context, '+' added, '-' removed, '…' skipped context; `h` = change (hunk) number. */
export interface DiffLine { t: ' ' | '+' | '-' | '…'; s: string; h?: number }

export interface DiffSummary { added: number; removed: number; hunks: number; lines: DiffLine[] }

const MAX_CELLS = 4_000_000; // LCS table budget; bigger files fall back to "replace all"
const CONTEXT = 2;
const MAX_LINES = 400;

function split(text: string): string[] {
	const lines = text ? text.replace(/\r\n/g, '\n').split('\n') : [];
	if (lines.length && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/** Full line diff (LCS); each run of consecutive changed lines is one hunk, numbered from 0. */
export function diffOps(before: string, after: string): DiffLine[] {
	const a = split(before);
	const b = split(after);
	let ops: DiffLine[];
	if (a.length * b.length > MAX_CELLS) {
		ops = [...a.map(s => ({ t: '-' as const, s })), ...b.map(s => ({ t: '+' as const, s }))];
	} else {
		const n = a.length, m = b.length;
		const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
			}
		}
		ops = [];
		let i = 0, j = 0;
		while (i < n && j < m) {
			if (a[i] === b[j]) { ops.push({ t: ' ', s: a[i] }); i++; j++; }
			else if (L[i + 1][j] >= L[i][j + 1]) { ops.push({ t: '-', s: a[i++] }); }
			else { ops.push({ t: '+', s: b[j++] }); }
		}
		while (i < n) { ops.push({ t: '-', s: a[i++] }); }
		while (j < m) { ops.push({ t: '+', s: b[j++] }); }
	}
	let hunk = -1;
	let inHunk = false;
	for (const o of ops) {
		if (o.t === ' ') {
			inHunk = false;
		} else {
			if (!inHunk) { hunk++; inHunk = true; }
			o.h = hunk;
		}
	}
	return ops;
}

/** Line diff with 2 lines of context around changes, for the chat's inline preview. */
export function lineDiff(before: string, after: string): DiffSummary {
	const ops = diffOps(before, after);
	const added = ops.filter(o => o.t === '+').length;
	const removed = ops.filter(o => o.t === '-').length;
	const hunks = ops.reduce((m, o) => Math.max(m, (o.h ?? -1) + 1), 0);
	// keep changes plus CONTEXT lines around them
	const keep = ops.map(() => false);
	ops.forEach((o, k) => {
		if (o.t !== ' ') {
			for (let x = Math.max(0, k - CONTEXT); x <= Math.min(ops.length - 1, k + CONTEXT); x++) { keep[x] = true; }
		}
	});
	const lines: DiffLine[] = [];
	ops.forEach((o, k) => {
		if (keep[k]) { lines.push(o); }
		else if (lines.length && lines[lines.length - 1].t !== '…') { lines.push({ t: '…', s: '' }); }
	});
	if (lines.length && lines[lines.length - 1].t === '…') { lines.pop(); }
	return { added, removed, hunks, lines: lines.slice(0, MAX_LINES) };
}

/** `before` with every change applied except the declined hunks. */
export function applyHunks(before: string, after: string, declined: Iterable<number>): string {
	const skip = new Set(declined);
	const out: string[] = [];
	for (const o of diffOps(before, after)) {
		const accepted = o.h === undefined || !skip.has(o.h);
		if (o.t === ' ' || (o.t === '+' && accepted) || (o.t === '-' && !accepted)) {
			out.push(o.s);
		}
	}
	const endsWithNewline = after.endsWith('\n') || (!after && before.endsWith('\n'));
	return out.join('\n') + (out.length && endsWithNewline ? '\n' : '');
}

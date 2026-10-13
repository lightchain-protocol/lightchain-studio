import { blank } from './security';

/**
 * The project as a map: its contracts, how they build on each other, and for
 * every function who may call it and whether money moves. Read from the source,
 * so it works before anything compiles.
 */
export type Who = 'read' | 'anyone' | 'restricted';
export interface MapFunction { name: string; line: number; who: Who; payable: boolean; sends: boolean; guard?: string }
export interface MapContract { name: string; kind: 'contract' | 'abstract' | 'interface' | 'library'; file: string; line: number; bases: string[]; uses: string[]; functions: MapFunction[]; state: string[]; depth: number }

function closing(code: string, open: number): number {
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		if (code[i] === '{') {
			depth++;
		} else if (code[i] === '}' && --depth === 0) {
			return i;
		}
	}
	return code.length - 1;
}

export function contractMap(files: { path: string; text: string }[]): MapContract[] {
	const out: MapContract[] = [];
	for (const f of files) {
		const code = blank(f.text);
		const lineOf = (i: number) => code.slice(0, i).split('\n').length;
		for (const h of code.matchAll(/\b(abstract\s+contract|contract|interface|library)\s+(\w+)(?:\s+is\s+([^{]+))?\s*\{/g)) {
			const open = h.index! + h[0].length - 1;
			const end = closing(code, open);
			const body = code.slice(open + 1, end);
			const functions: MapFunction[] = [];
			let outside = body;
			for (const m of body.matchAll(/\b(function\s+(\w+)|constructor|receive|fallback)\s*\([^)]*\)([^{;]*)([{;])/g)) {
				const name = m[2] ?? m[1];
				const header = m[3];
				let fnBody = '';
				if (m[4] === '{') {
					const o = m.index! + m[0].length - 1;
					const c = closing(body, o);
					fnBody = body.slice(o + 1, c);
					outside = outside.slice(0, o) + ' '.repeat(c - o + 1) + outside.slice(c + 1);
				}
				if (/\b(private|internal)\b/.test(header) || name === 'constructor') {
					continue;
				}
				const mods = header.replace(/\breturns\s*\([^)]*\)/, '').replace(/\b(public|external|payable|virtual|override(\s*\([^)]*\))?|view|pure)\b/g, '').trim().split(/\s+/).filter(Boolean).map(x => x.replace(/\(.*$/, ''));
				const guardMod = mods.find(x => /only|auth|admin|role|owner|governor|guardian|whenNotPaused/i.test(x));
				const checksSender = /\b(require|if|revert)\b[^;]*\bmsg\.sender\b\s*(==|!=)|_checkOwner|_checkRole|hasRole\s*\(/.test(fnBody);
				const read = /\b(view|pure)\b/.test(header);
				functions.push({
					name, line: lineOf(open + 1 + m.index!), payable: /\bpayable\b/.test(header) || name === 'receive',
					sends: /\.call\s*\{[^}]*value|\.transfer\s*\(|\.send\s*\(|safeTransfer|transferFrom\s*\(/.test(fnBody),
					who: read ? 'read' : guardMod || checksSender ? 'restricted' : 'anyone',
					guard: guardMod ?? (checksSender && !read ? 'checks the caller' : undefined),
				});
			}
			const state = [...outside.matchAll(/^\s*(?:mapping\s*\([^;]*\)|[\w.]+(?:\s*\[[^\]]*\])*)\s+(?:(?:public|private|internal|constant|immutable|override)\s+)*(\w+)\s*(?:=[^;]*)?;/gm)]
				.filter(m => !/^\s*(return|emit|revert|delete|using|event|error|import)\b/.test(m[0])).map(m => m[1]);
			out.push({
				name: h[2], kind: h[1].startsWith('abstract') ? 'abstract' : h[1] as MapContract['kind'], file: f.path, line: lineOf(h.index!),
				bases: h[3] ? h[3].split(',').map(b => b.trim().replace(/\(.*$/, '').trim()).filter(Boolean) : [],
				uses: [], functions, state, depth: 0,
			});
			out[out.length - 1].uses = [body];
		}
	}
	const names = new Set(out.map(c => c.name));
	for (const c of out) {
		const body = c.uses[0] ?? '';
		c.uses = [...names].filter(n => n !== c.name && !c.bases.includes(n) && new RegExp(`\\b${n}\\b`).test(body));
		c.bases = c.bases.filter(b => b); // unknown bases (libraries, OpenZeppelin) stay listed by name
	}
	// rows: a contract sits below everything it builds on
	const depthOf = (c: MapContract, seen = new Set<string>()): number => {
		if (seen.has(c.name)) {
			return 0;
		}
		seen.add(c.name);
		const parents = c.bases.map(b => out.find(x => x.name === b)).filter((x): x is MapContract => !!x);
		return parents.length ? 1 + Math.max(...parents.map(p => depthOf(p, seen))) : 0;
	};
	out.forEach(c => { c.depth = depthOf(c); });
	return out.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file) || a.line - b.line);
}

/** "setFee" / "transfer_ownership" → "set fee" / "transfer ownership" */
export function plainName(id: string): string {
	return id.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
}

const listed = (names: string[]) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * A contract in two or three everyday sentences: what it is, what anyone can
 * do with it, what only some may do, and whether money goes in or out.
 */
export function describeContract(c: MapContract): string {
	if (c.kind === 'interface') {
		return 'A list of functions another contract promises to have. It holds no code or money itself.';
	}
	if (c.kind === 'library') {
		return 'Shared helper code that other contracts reuse. It holds no money itself.';
	}
	const fns = c.functions.filter(f => f.name !== 'receive' && f.name !== 'fallback');
	const anyone = fns.filter(f => f.who === 'anyone').map(f => plainName(f.name));
	const restricted = fns.filter(f => f.who === 'restricted').map(f => plainName(f.name));
	const takes = c.functions.some(f => f.payable);
	const pays = c.functions.some(f => f.sends);
	const money = takes && pays ? 'It takes LCAI in and can pay it out.' : takes ? 'It takes LCAI in, and nothing in it pays LCAI back out.' : pays ? 'It can send funds out.' : '';
	const parts = [
		c.kind === 'abstract' ? 'A building block other contracts build on.' : '',
		money,
		anyone.length ? `Anyone can ${listed(anyone.slice(0, 4))}${anyone.length > 4 ? ` and ${anyone.length - 4} more` : ''}.` : fns.length && !restricted.length ? 'Nothing in it changes anything: it only answers questions.' : '',
		restricted.length ? `Only the owner or an allowed caller can ${listed(restricted.slice(0, 4))}${restricted.length > 4 ? ` and ${restricted.length - 4} more` : ''}.` : '',
	].filter(Boolean);
	return parts.join(' ') || 'It has no functions others can call yet.';
}

/**
 * A compact outline of the project's Solidity code (contracts, functions,
 * events, public state) plus deployed addresses. Sent instead of whole files so
 * the model knows the codebase within its small context window.
 */
export interface SolFile { path: string; text: string }
export interface Deployed { name?: string; address: string }

const MAX_CHARS = 3_000;

function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function squash(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

interface Unit { kind: string; name: string; bases?: string; members: string[]; brief: string[] }

/** Outline of one Solidity file. */
export function outlineSolidity(text: string, withParams = true): Unit[] {
	const src = stripComments(text);
	const heads = [...src.matchAll(/\b(abstract\s+contract|contract|interface|library)\s+(\w+)(?:\s+is\s+([^{]+))?\s*\{/g)];
	return heads.map((h, i) => {
		const body = src.slice(h.index! + h[0].length, i + 1 < heads.length ? heads[i + 1].index : src.length);
		const members: string[] = [];
		const brief: string[] = [];
		for (const m of body.matchAll(/^\s*([\w.\[\]]+(?:\s*\([^)]*\))?)\s+public\s+(?:(?:constant|immutable|override)\s+)*(\w+)\s*[;=]/gm)) {
			members.push(`var ${m[2]}: ${squash(m[1])}`);
			brief.push(m[2]);
		}
		for (const m of body.matchAll(/\b(function\s+(\w+)|constructor|receive|fallback)\s*\(([^)]*)\)([^{;]*)/g)) {
			const name = m[2] ?? m[1];
			const mods = squash(m[4]).replace(/\b(virtual|override)\b\s*/g, '').trim();
			if (/\b(private|internal)\b/.test(mods) && name !== 'constructor') {
				continue; // callers only need the external surface
			}
			members.push(`fn ${name}(${withParams ? squash(m[3]) : ''})${mods ? ' ' + mods : ''}`);
			brief.push(`${name}()`);
		}
		for (const m of body.matchAll(/\bevent\s+(\w+)\s*\(([^)]*)\)/g)) {
			members.push(`event ${m[1]}(${withParams ? squash(m[2]) : ''})`);
		}
		for (const m of body.matchAll(/\berror\s+(\w+)\s*\(([^)]*)\)/g)) {
			members.push(`error ${m[1]}(${withParams ? squash(m[2]) : ''})`);
		}
		return { kind: h[1].replace(/\s+/g, ' '), name: h[2], bases: h[3] ? squash(h[3]) : undefined, members, brief };
	});
}

/** The project map text; empty when there is nothing to show. */
export function projectMap(files: SolFile[], deployed: Deployed[], network: string): string {
	const render = (level: 0 | 1 | 2) => {
		const parts: string[] = [];
		for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
			const units = outlineSolidity(f.text, level === 0);
			if (!units.length) {
				continue;
			}
			for (const u of units) {
				const head = `${f.path}: ${u.kind} ${u.name}${u.bases ? ` is ${u.bases}` : ''}`;
				if (level === 2) {
					parts.push(`${head}${u.brief.length ? ` — ${u.brief.join(', ')}` : ''}`);
				} else {
					parts.push([head, ...u.members.map(m => `  ${m}`)].join('\n'));
				}
			}
		}
		if (deployed.length) {
			parts.push(`Deployed on ${network}: ${deployed.map(d => `${d.name ?? 'contract'} ${d.address}`).join('; ')}`);
		}
		return parts.join('\n');
	};
	for (const level of [0, 1, 2] as const) {
		const text = render(level);
		if (text.length <= MAX_CHARS) {
			return text;
		}
	}
	return render(2).slice(0, MAX_CHARS) + '\n… (more files — use list_dir / search)';
}

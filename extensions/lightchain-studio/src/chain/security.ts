/**
 * Security check for Solidity, run as you type: the mistakes that lose funds
 * most often, found by reading the code (no compiler, no network). Each finding
 * says what is wrong in plain words and what to do about it; Lightchain AI can
 * apply the fix. It is a safety net, not an audit — it knows patterns, not intent.
 */
export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
	rule: string;
	severity: Severity;
	/** 0-based position of the code the finding is about. */
	line: number; col: number; endLine: number; endCol: number;
	/** One sentence a non-expert understands. */
	message: string;
	/** What to do instead. */
	fix: string;
}

/** Comments and string contents replaced by spaces, so positions still match the file. */
export function blank(src: string): string {
	let out = '';
	let i = 0;
	while (i < src.length) {
		const two = src.slice(i, i + 2);
		if (two === '//') {
			const end = src.indexOf('\n', i);
			const stop = end < 0 ? src.length : end;
			out += ' '.repeat(stop - i);
			i = stop;
		} else if (two === '/*') {
			const end = src.indexOf('*/', i + 2);
			const stop = end < 0 ? src.length : end + 2;
			out += src.slice(i, stop).replace(/[^\n]/g, ' ');
			i = stop;
		} else if (src[i] === '"' || src[i] === '\'') {
			const quote = src[i];
			let j = i + 1;
			while (j < src.length && src[j] !== quote && src[j] !== '\n') {
				j += src[j] === '\\' ? 2 : 1;
			}
			out += quote + ' '.repeat(Math.max(0, j - i - 1)) + (src[j] === quote ? quote : '');
			i = Math.min(src.length, j + 1);
		} else {
			out += src[i++];
		}
	}
	return out;
}

interface Fn { name: string; header: string; body: string; start: number; bodyStart: number; end: number }

/** Index of the brace closing the one at `open`. */
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

function functions(code: string): Fn[] {
	const out: Fn[] = [];
	for (const m of code.matchAll(/\b(function\s+(\w+)|constructor|receive|fallback)\s*\([^)]*\)([^{;]*)\{/g)) {
		const open = m.index! + m[0].length - 1;
		const end = closing(code, open);
		out.push({ name: m[2] ?? m[1], header: m[0], body: code.slice(open + 1, end), start: m.index!, bodyStart: open + 1, end });
	}
	return out;
}

/** Names of the contract's own storage variables (declared outside functions). */
function stateVars(code: string, fns: Fn[]): { name: string; array: boolean }[] {
	let outside = code;
	for (const f of [...fns].reverse()) {
		outside = outside.slice(0, f.bodyStart) + ' '.repeat(f.end - f.bodyStart) + outside.slice(f.end);
	}
	const vars: { name: string; array: boolean }[] = [];
	for (const m of outside.matchAll(/^\s*((?:mapping\s*\([^;]*\)|[\w.]+(?:\s*\[[^\]]*\])*))\s+(?:(?:public|private|internal|constant|immutable|override|transient)\s+)*(\w+)\s*(?:=[^;]*)?;/gm)) {
		if (!/^(return|emit|revert|delete|import|using|pragma|event|error|function|modifier|struct|enum|contract|interface|library|if|else|for|while|require|assert)$/.test(m[1].trim()) && !/\b(constant|immutable)\b/.test(m[0])) {
			vars.push({ name: m[2], array: /\[[^\]]*\]\s*$/.test(m[1].trim()) });
		}
	}
	return vars;
}

const SENDS = /\.call\s*\{[^}]*value\s*:|\.call\s*\(|\.transfer\s*\(|\.send\s*\(|\.safeTransfer(?:From)?\s*\(|\.transferFrom\s*\(/g;

export function scanSolidity(text: string): Finding[] {
	const code = blank(text);
	const lineStarts = [0];
	for (let i = 0; i < code.length; i++) {
		if (code[i] === '\n') {
			lineStarts.push(i + 1);
		}
	}
	const pos = (offset: number) => {
		let lo = 0, hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
		}
		return { line: lo, col: offset - lineStarts[lo] };
	};
	const findings: Finding[] = [];
	const add = (rule: string, severity: Severity, start: number, length: number, message: string, fix: string) => {
		const a = pos(start), b = pos(start + length);
		if (!findings.some(f => f.rule === rule && f.line === a.line)) {
			findings.push({ rule, severity, line: a.line, col: a.col, endLine: b.line, endCol: b.col, message, fix });
		}
	};
	const fns = functions(code);
	const vars = stateVars(code, fns);

	for (const m of code.matchAll(/\btx\.origin\b/g)) {
		const stmtStart = Math.max(code.lastIndexOf(';', m.index!), code.lastIndexOf('{', m.index!), code.lastIndexOf('}', m.index!)) + 1;
		const stmt = code.slice(stmtStart, code.indexOf(';', m.index!) + 1 || undefined);
		if (/\b(require|if|assert)\b|==|!=/.test(stmt)) {
			add('tx-origin', 'high', m.index!, m[0].length, 'tx.origin is used to decide who may do this. A malicious contract the owner interacts with can pass this check.', 'Use msg.sender instead of tx.origin.');
		}
	}

	for (const m of code.matchAll(/\bselfdestruct\s*\(|\bsuicide\s*\(/g)) {
		add('selfdestruct', 'high', m.index!, m[0].length - 1, 'selfdestruct can delete this contract and send away everything it holds.', 'Remove it, or make sure only the owner can reach it and that this is really intended.');
	}

	for (const m of code.matchAll(/\.delegatecall\s*\(/g)) {
		add('delegatecall', 'medium', m.index! + 1, 12, 'delegatecall runs another contract\'s code with this contract\'s storage and funds.', 'Only delegatecall to an address you control and can never be changed by a user.');
	}

	for (const m of code.matchAll(/pragma\s+solidity\s+[^;]*?\b0\.([0-7])\.\d+/g)) {
		add('old-compiler', 'medium', m.index!, m[0].length, `Solidity 0.${m[1]} does not stop numbers from overflowing: a balance can wrap around to a huge value.`, 'Use Solidity ^0.8.24, which checks arithmetic for you.');
	}

	// a low-level call whose result nobody looks at
	for (const m of code.matchAll(/[\w.\])]+\.(call|send)\s*(\{[^}]*\})?\s*\(/g)) {
		const stmtStart = Math.max(code.lastIndexOf(';', m.index!), code.lastIndexOf('{', m.index!), code.lastIndexOf('}', m.index!)) + 1;
		const before = code.slice(stmtStart, m.index!);
		if (!/=|\b(require|if|assert|return)\b/.test(before)) {
			add('unchecked-call', 'high', m.index!, m[0].length - 1, `The result of .${m[1]}() is ignored: if the payment fails, the contract carries on as if it worked.`, `Keep the result and check it: (bool ok, ) = ….${m[1] === 'call' ? 'call{value: amount}("")' : 'send(amount)'}; require(ok, "payment failed");`);
		}
	}

	// predictable "randomness"
	for (const m of code.matchAll(/\bkeccak256\s*\(|%/g)) {
		const end = code.indexOf(';', m.index!);
		const stmtStart = Math.max(code.lastIndexOf(';', m.index!), code.lastIndexOf('{', m.index!)) + 1;
		const stmt = code.slice(stmtStart, end < 0 ? undefined : end);
		const src = /\bblock\.(timestamp|prevrandao|difficulty|number|coinbase)\b|\bblockhash\s*\(/.exec(stmt);
		if (src && /\bkeccak256\b/.test(stmt) && /%|\brandom|\bwinner|\blucky|\bseed|\bpick/i.test(stmt + code.slice(stmtStart - 80, stmtStart))) {
			add('weak-randomness', 'high', stmtStart + src.index, src[0].length, 'This "random" number comes from block data, which validators and other contracts can predict or influence.', 'Do not decide who wins from block.timestamp, block.prevrandao or blockhash. Use a commit-reveal scheme or a randomness oracle.');
		}
	}

	for (const f of fns) {
		const header = f.header;
		const external = /\b(public|external)\b/.test(header);
		const readOnly = /\b(view|pure)\b/.test(header);

		// funds or state-changing calls sent before the contract updates its own records
		if (!/\bnonReentrant\b/.test(header) && !readOnly) {
			for (const s of f.body.matchAll(SENDS)) {
				const isTokenOrValue = /value\s*:|\.transfer\s*\(|\.send\s*\(|safeTransfer|transferFrom/.test(s[0]) || /\.call\s*\(/.test(s[0]);
				if (!isTokenOrValue) {
					continue;
				}
				const after = f.body.slice(s.index! + s[0].length);
				const write = vars.map(v => new RegExp(`(^|[;{}\\s])(${v.name})\\b\\s*(\\[[^;=]*\\])*\\s*(=(?!=)|\\+=|-=|\\+\\+|--)|\\bdelete\\s+${v.name}\\b`).exec(after)).find(Boolean);
				if (write) {
					add('reentrancy', 'high', f.bodyStart + s.index! + 1, s[0].length - 1, `Money leaves the contract here, but ${write[2] ?? 'its records'} is only updated afterwards. The receiver can call ${f.name}() again before that and be paid twice.`, 'Update the contract\'s own records first, then send (checks → effects → interactions), or add a nonReentrant guard.');
					break;
				}
			}
		}

		// a sensitive function anyone can call
		if (external && !readOnly && /^(withdraw(All|Fees|Funds)?|sweep|rescue\w*|drain|mint|burn(From)?|set[A-Z]\w*|update[A-Z]\w*|change[A-Z]\w*|pause|unpause|upgrade\w*|transferOwnership|renounceOwnership|initialize|destroy|kill|close)$/.test(f.name)) {
			const mods = header.replace(/^[^)]*\)/, '').replace(/\b(public|external|payable|virtual|override|returns\s*\([^)]*\))\b/g, '').replace(/[{\s]/g, ' ').trim();
			const guarded = /\w/.test(mods.replace(/\breturns\b/g, '')) || /\bmsg\.sender\b|\btx\.origin\b|_checkOwner|_checkRole|hasRole|_msgSender\s*\(\)/.test(f.body);
			if (!guarded) {
				add('open-access', 'high', f.start + header.indexOf(f.name), f.name.length, `Anyone can call ${f.name}(): nothing checks who is asking.`, `Restrict it, for example with an onlyOwner modifier or require(msg.sender == owner, "not owner").`);
			}
		}

		// a loop that grows with the contract's data
		for (const loop of f.body.matchAll(/\bfor\s*\([^;]*;[^;]*?\b(\w+)\.length\b[^;]*;/g)) {
			if (vars.some(v => v.name === loop[1] && v.array) && !readOnly) {
				add('unbounded-loop', 'medium', f.bodyStart + loop.index!, 3, `This loop goes through every entry of ${loop[1]}. As the list grows it costs more gas, until the function can no longer run at all.`, 'Process a limited number of entries per call, or let each user act for themselves (pull instead of push).');
			}
		}
	}
	return findings.sort((a, b) => a.line - b.line || a.col - b.col);
}

/** One line per finding for prompts and reports. */
export function describeFindings(path: string, findings: Finding[]): string {
	return findings.map(f => `${path}:${f.line + 1}: [${f.severity}] ${f.message} Fix: ${f.fix}`).join('\n');
}

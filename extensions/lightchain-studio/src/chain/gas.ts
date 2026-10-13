/**
 * Gas shown next to the code: what each function costs to call, in gas and in
 * LCAI, from the compiler's own estimates (forge inspect … gasEstimates).
 */
export interface GasEstimates { creation?: { totalCost?: string }; external?: Record<string, string> }
export interface GasLine { line: number; /** contract-level (deployment) or function */ kind: 'deploy' | 'call'; name: string; gas?: number; title: string }

export function formatGas(n: number): string {
	return Math.round(n).toLocaleString('en-US');
}

/** Gas × price in LCAI, short: 0.0021, 0.00004, <0.00001. */
export function formatCost(gas: number, weiPerGas: bigint | undefined): string {
	if (weiPerGas === undefined) {
		return '';
	}
	const lcai = Number(BigInt(Math.round(gas)) * weiPerGas) / 1e18;
	if (lcai === 0) {
		return '';
	}
	return lcai < 0.00001 ? '<0.00001 LCAI' : `${lcai >= 1 ? lcai.toFixed(2) : lcai.toPrecision(2).replace(/\.?0+$/, '')} LCAI`.replace(/(\d)e-(\d+)/, (_m, d, e) => `0.${'0'.repeat(Number(e) - 1)}${d}`);
}

/**
 * Where to show gas in a Solidity file: above each contract (deployment) and
 * each external function with an estimate. `previous` adds "since last build".
 */
export function gasLines(text: string, byContract: Record<string, GasEstimates>, weiPerGas?: bigint, previous: Record<string, GasEstimates> = {}): GasLine[] {
	const lines: GasLine[] = [];
	const src = text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
	const lineOf = (index: number) => src.slice(0, index).split('\n').length - 1;
	const heads = [...src.matchAll(/^[ \t]*(?:abstract\s+)?contract\s+(\w+)[^{;]*\{/gm)];
	heads.forEach((h, i) => {
		const name = h[1];
		const est = byContract[name];
		if (!est) {
			return;
		}
		const cost = (g: number) => { const c = formatCost(g, weiPerGas); return c ? ` · ${c}` : ''; };
		const delta = (now: number, before: string | undefined) => {
			const was = Number(before);
			return before !== undefined && Number.isFinite(was) && was !== now ? ` (${now > was ? '+' : '−'}${formatGas(Math.abs(now - was))} since last build)` : '';
		};
		const deploy = Number(est.creation?.totalCost);
		if (Number.isFinite(deploy)) {
			lines.push({ line: lineOf(h.index! + h[0].indexOf('contract')), kind: 'deploy', name, gas: deploy, title: `Deploying costs about ${formatGas(deploy)} gas${cost(deploy)}${delta(deploy, previous[name]?.creation?.totalCost)}` });
		}
		const body = src.slice(h.index! + h[0].length, i + 1 < heads.length ? heads[i + 1].index : src.length);
		const offset = h.index! + h[0].length;
		for (const f of body.matchAll(/\bfunction\s+(\w+)\s*\(/g)) {
			// the estimate's key is name(types); an overloaded name cannot be told apart here
			const keys = Object.keys(est.external ?? {}).filter(k => k.startsWith(`${f[1]}(`));
			if (keys.length !== 1) {
				continue;
			}
			const raw = est.external![keys[0]];
			const gas = Number(raw);
			const line = lineOf(offset + f.index!);
			lines.push(Number.isFinite(gas)
				? { line, kind: 'call', name: f[1], gas, title: `About ${formatGas(gas)} gas per call${cost(gas)}${delta(gas, previous[name]?.external?.[keys[0]])}` }
				: { line, kind: 'call', name: f[1], title: 'Gas depends on the input (loops, calls to others or data of any length)' });
		}
	});
	return lines;
}

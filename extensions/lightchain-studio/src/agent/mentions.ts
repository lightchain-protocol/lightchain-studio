import * as vscode from 'vscode';
import { LightchainNetwork, addressUrl, txUrl } from '../networks';
import { MentionItem, mentionableFiles } from './context';
import { outlineSolidity } from './projectMap';

/** Solidity files of the project (open buffers win over disk). */
export async function solidityFiles(): Promise<{ path: string; text: string }[]> {
	const uris = await vscode.workspace.findFiles('**/*.sol', '{**/lib/**,**/node_modules/**,**/out/**,**/cache/**}', 200);
	return Promise.all(uris.map(async uri => {
		const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
		const text = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
		return { path: vscode.workspace.asRelativePath(uri, false), text };
	}));
}

/** Everything the @-picker offers: deployed contracts, contracts, then files. */
export async function mentionItems(deployed: { name?: string; address: string }[]): Promise<MentionItem[]> {
	const contracts: MentionItem[] = [];
	for (const f of await solidityFiles()) {
		for (const u of outlineSolidity(f.text, false)) {
			contracts.push({ id: `contract:${u.name}@${f.path}`, label: u.name, detail: `${u.kind} · ${f.path}`, kind: 'contract' });
		}
	}
	return [
		...deployed.map(d => ({ id: `deployed:${d.address}`, label: d.name ?? d.address, detail: `deployed · ${d.address.slice(0, 6)}…${d.address.slice(-4)}`, kind: 'deployed' as const })),
		...contracts,
		...(await mentionableFiles()).map(f => ({ id: f, label: f, kind: 'file' as const })),
	];
}

async function rpc<T>(network: LightchainNetwork, method: string, params: unknown[]): Promise<T> {
	const res = await fetch(network.rpcUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		signal: AbortSignal.timeout(15_000),
	});
	const body = await res.json() as { result?: T; error?: { message: string } };
	if (body.error) {
		throw new Error(body.error.message);
	}
	return body.result as T;
}

const lcai = (hex: string | undefined) => hex ? `${(Number(BigInt(hex)) / 1e18).toString()} LCAI` : '0 LCAI';

/** Context notes for deployed contracts and transactions. */
export async function resolveMention(mention: string, network: LightchainNetwork, deployed: { name?: string; address: string }[]): Promise<string | undefined> {
	const dep = /^deployed:(0x[0-9a-fA-F]{40})$/.exec(mention);
	if (dep) {
		const d = deployed.find(x => x.address.toLowerCase() === dep[1].toLowerCase());
		const name = d?.name;
		let surface = '';
		if (name) {
			for (const f of await solidityFiles()) {
				const u = outlineSolidity(f.text).find(x => x.name === name);
				if (u) {
					surface = `\nSource: ${f.path}\n${u.members.map(m => `  ${m}`).join('\n')}`;
					break;
				}
			}
		}
		const code = await rpc<string>(network, 'eth_getCode', [dep[1], 'latest']).catch(() => undefined);
		const live = code === undefined ? '' : code === '0x' ? ' (no code at this address on this network)' : '';
		return `Deployed contract ${name ?? ''} at ${dep[1]} on Lightchain ${network.label} (chain ${network.chainId})${live}. Explorer: ${addressUrl(network, dep[1])}${surface}`;
	}
	const tx = /^tx:(0x[0-9a-fA-F]{64})$/.exec(mention);
	if (tx) {
		const [t, r] = await Promise.all([
			rpc<Record<string, string> | null>(network, 'eth_getTransactionByHash', [tx[1]]),
			rpc<Record<string, unknown> | null>(network, 'eth_getTransactionReceipt', [tx[1]]),
		]);
		if (!t) {
			return `Transaction ${tx[1]} was not found on Lightchain ${network.label}.`;
		}
		const status = !r ? 'pending' : r.status === '0x1' ? 'succeeded' : 'reverted';
		const known = deployed.find(d => d.address.toLowerCase() === String(t.to ?? '').toLowerCase());
		return [
			`Transaction ${tx[1]} on Lightchain ${network.label}: ${status}.`,
			`From ${t.from} to ${t.to ?? '(contract creation)'}${known?.name ? ` (${known.name})` : ''}, value ${lcai(t.value)}.`,
			t.input && t.input !== '0x' ? `Calldata selector ${t.input.slice(0, 10)}, ${(t.input.length - 10) / 2} bytes of arguments.` : 'No calldata.',
			r ? `Gas used ${Number(r.gasUsed)}, ${(r.logs as unknown[] | undefined)?.length ?? 0} log(s)${r.contractAddress ? `, created ${r.contractAddress}` : ''}.` : '',
			`Explorer: ${txUrl(network, tx[1])}`,
		].filter(Boolean).join(' ');
	}
	return undefined;
}

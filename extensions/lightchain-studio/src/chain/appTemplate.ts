import type { Abi, AbiFunction, AbiParameter } from 'viem';

/**
 * A small web app for one deployed contract, as a single HTML file: it shows the
 * contract's values, lets visitors call its functions with their browser wallet
 * and follows the Lightchain look. No build step — open it, host it anywhere, or
 * let Lightchain AI reshape it into the real product.
 */
export interface AppSpec { name: string; address: string; abi: Abi; network: { label: string; chainId: number; rpcUrl: string; explorerUrl: string } }

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
/** "feeBps" / "set_fee" → "Fee bps" / "Set fee" */
export const words = (id: string) => { const w = id.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase(); return w ? w[0].toUpperCase() + w.slice(1) : id; };

function hint(p: AbiParameter): string {
	if (p.type === 'address') { return '0x… address'; }
	if (/^u?int\d*$/.test(p.type)) { return 'a whole number'; }
	if (p.type === 'bool') { return 'true or false'; }
	if (p.type === 'string') { return 'text'; }
	if (/^bytes/.test(p.type)) { return '0x… data'; }
	return `${p.type} as JSON`;
}

export function generateApp(spec: AppSpec): string {
	const fns = spec.abi.filter((x): x is AbiFunction => x.type === 'function');
	const reads = fns.filter(f => f.stateMutability === 'view' || f.stateMutability === 'pure');
	const writes = fns.filter(f => f.stateMutability !== 'view' && f.stateMutability !== 'pure');
	const config = { name: spec.name, address: spec.address, chainId: spec.network.chainId, network: spec.network.label, rpcUrl: spec.network.rpcUrl, explorer: spec.network.explorerUrl, abi: spec.abi };
	const form = (f: AbiFunction, kind: 'read' | 'write') => `
		<form class="card" data-fn="${esc(f.name)}" data-sig="${esc(`${f.name}(${f.inputs.map(i => i.type).join(',')})`)}" data-kind="${kind}"${f.stateMutability === 'payable' ? ' data-payable' : ''}>
			<h3>${esc(words(f.name))}</h3>
			${f.inputs.map((p, i) => `<label>${esc(words(p.name || `value ${i + 1}`))}<input name="arg${i}" data-type="${esc(p.type)}" placeholder="${esc(hint(p))}" autocomplete="off"></label>`).join('\n\t\t\t')}
			${f.stateMutability === 'payable' ? '<label>LCAI to send<input name="value" placeholder="0" inputmode="decimal" autocomplete="off"></label>' : ''}
			<button class="${kind === 'write' ? 'primary' : ''}" type="submit">${kind === 'write' ? esc(words(f.name)) : 'Look up'}</button>
			<output></output>
		</form>`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(spec.name)} on Lightchain</title>
<!-- Made with Lightchain Studio for ${esc(spec.name)} at ${esc(spec.address)} (Lightchain ${esc(spec.network.label)}). One file, no build step: edit it freely. -->
<style>
	:root { --bg: #070710; --card: #0f0f14; --raise: #14152c; --line: rgba(255, 255, 255, 0.1); --t1: #f5f6ff; --t2: #ccceef; --t3: #7376aa; --accent: #5b4bff; --grad: linear-gradient(90deg, #df04ae 0%, #412ffd 100%); --ok: #3eb75e; --bad: #ff6b69; }
	* { box-sizing: border-box; }
	body { margin: 0; background: var(--bg); color: var(--t2); font: 15px/1.6 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
	main { max-width: 880px; margin: 0 auto; padding: 40px 20px 80px; }
	header { display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 28px; }
	header div { flex: 1; min-width: 240px; }
	.eyebrow { padding-left: 10px; border-left: 3px solid #dd00ac; color: var(--t3); font-size: 12px; font-weight: 500; letter-spacing: .5px; text-transform: uppercase; }
	h1 { margin: 12px 0 4px; color: var(--t1); font-size: 30px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.2; }
	.sub { color: var(--t3); font-size: 13px; word-break: break-all; }
	.sub a { color: inherit; }
	h2 { margin: 32px 0 12px; color: var(--t2); font-size: 12px; font-weight: 600; letter-spacing: .5px; text-transform: uppercase; opacity: .6; }
	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
	.card { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 16px; border: 1px solid rgba(112, 100, 233, 0.22); border-radius: 14px; background: var(--card); }
	.card h3 { margin: 0; color: var(--t1); font-size: 15px; font-weight: 600; }
	.stat b { display: block; color: var(--t1); font-size: 20px; font-weight: 600; letter-spacing: -0.01em; word-break: break-all; }
	.stat span { color: var(--t3); font-size: 12px; }
	label { display: flex; flex-direction: column; gap: 4px; color: var(--t3); font-size: 12px; }
	input { height: 40px; padding: 0 12px; border: 2px solid var(--line); border-radius: 10px; background: transparent; color: var(--t2); font: inherit; font-size: 14px; outline: none; transition: border-color .2s; }
	input:focus { border-color: var(--accent); }
	button { height: 40px; padding: 0 18px; border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 8px; background: rgba(255, 255, 255, 0.1); color: var(--t2); font: inherit; font-size: 13px; letter-spacing: .5px; text-transform: uppercase; cursor: pointer; transition: all .2s; }
	button:hover:not(:disabled) { border-color: var(--accent); background: var(--accent); color: #fff; }
	button.primary { border: 0; background: var(--grad); color: #fff; }
	button.primary:hover:not(:disabled) { filter: brightness(1.2); }
	button:disabled { opacity: .5; cursor: not-allowed; }
	output { display: block; min-height: 0; color: var(--t2); font-size: 13px; word-break: break-word; }
	output.ok { color: var(--ok); } output.bad { color: var(--bad); }
	output a { color: inherit; }
	.note { margin-top: 28px; color: var(--t3); font-size: 12px; }
</style>
</head>
<body>
<main>
	<header>
		<div>
			<span class="eyebrow">Lightchain ${esc(spec.network.label)}</span>
			<h1>${esc(words(spec.name))}</h1>
			<span class="sub">Contract <a id="contract" target="_blank" rel="noopener">${esc(spec.address)}</a></span>
		</div>
		<button class="primary" id="connect" type="button">Connect wallet</button>
	</header>
${reads.some(f => !f.inputs.length) ? `	<h2>Right now</h2>
	<div class="grid" id="stats">${reads.filter(f => !f.inputs.length).map(f => `
		<div class="card stat" data-read="${esc(f.name)}"><span>${esc(words(f.name))}</span><b>…</b></div>`).join('')}
	</div>` : ''}
${writes.length ? `	<h2>Do something</h2>
	<div class="grid">${writes.map(f => form(f, 'write')).join('')}
	</div>` : ''}
${reads.some(f => f.inputs.length) ? `	<h2>Look something up</h2>
	<div class="grid">${reads.filter(f => f.inputs.length).map(f => form(f, 'read')).join('')}
	</div>` : ''}
	<p class="note">Changing something needs a browser wallet (MetaMask, Rabby…) with LCAI on Lightchain ${esc(spec.network.label)}. Reading is free.</p>
</main>
<script type="module">
	import { createPublicClient, createWalletClient, custom, http, defineChain, parseEther, formatEther } from 'https://esm.sh/viem@2?bundle'; // one file instead of hundreds of small requests

	const CONFIG = ${JSON.stringify(config).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '')};
	const chain = defineChain({ id: CONFIG.chainId, name: 'Lightchain ' + CONFIG.network, nativeCurrency: { name: 'LCAI', symbol: 'LCAI', decimals: 18 }, rpcUrls: { default: { http: [CONFIG.rpcUrl] } }, blockExplorers: { default: { name: 'Lightscan', url: CONFIG.explorer } } });
	const reader = createPublicClient({ chain, transport: http() });
	const $ = (s, root = document) => root.querySelector(s);
	$('#contract').href = CONFIG.explorer + '/address/' + CONFIG.address;
	let account;

	const show = v => typeof v === 'bigint' ? v.toLocaleString('en-US') : Array.isArray(v) ? v.map(show).join(', ') : v && typeof v === 'object' ? JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? x.toString() : x) : String(v);
	function parse(type, text) {
		const t = text.trim();
		if (/^u?int\\d*$/.test(type)) return BigInt(t.replace(/[,_\\s]/g, ''));
		if (type === 'bool') return /^(true|yes|1)$/i.test(t);
		if (type === 'address' || type === 'string' || /^bytes/.test(type)) return t;
		return JSON.parse(t, (_k, v) => typeof v === 'string' && /^\\d+$/.test(v) ? BigInt(v) : v);
	}
	const fnOf = form => CONFIG.abi.find(x => x.type === 'function' && x.name + '(' + x.inputs.map(i => i.type).join(',') + ')' === form.dataset.sig);
	const argsOf = form => fnOf(form).inputs.map((p, i) => parse(p.type, form.elements['arg' + i].value));
	const plain = err => (err.shortMessage || err.message || String(err)).split('\\n')[0];

	async function refresh() {
		for (const el of document.querySelectorAll('[data-read]')) {
			try { el.querySelector('b').textContent = show(await reader.readContract({ address: CONFIG.address, abi: CONFIG.abi, functionName: el.dataset.read })); }
			catch { el.querySelector('b').textContent = '—'; }
		}
	}

	async function connect() {
		if (!window.ethereum) { alert('Install a browser wallet such as MetaMask or Rabby to change things. Reading works without one.'); return; }
		[account] = await window.ethereum.request({ method: 'eth_requestAccounts' });
		try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + CONFIG.chainId.toString(16) }] }); }
		catch { await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x' + CONFIG.chainId.toString(16), chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [CONFIG.rpcUrl], blockExplorerUrls: [CONFIG.explorer] }] }); }
		$('#connect').textContent = account.slice(0, 6) + '…' + account.slice(-4);
	}
	$('#connect').onclick = () => connect().catch(err => alert(plain(err)));

	for (const form of document.querySelectorAll('form[data-fn]')) {
		form.onsubmit = async e => {
			e.preventDefault();
			const out = $('output', form), button = $('button', form);
			out.className = ''; out.textContent = 'Working…'; button.disabled = true;
			try {
				const call = { address: CONFIG.address, abi: [fnOf(form)], functionName: form.dataset.fn, args: argsOf(form) };
				if (form.dataset.kind === 'read') {
					out.textContent = show(await reader.readContract(call));
				} else {
					if (!account) await connect();
					const value = form.hasAttribute('data-payable') && form.elements.value.value.trim() ? parseEther(form.elements.value.value.trim()) : undefined;
					await reader.simulateContract({ ...call, account, value }); // fails here, with the reason, before the wallet opens
					out.textContent = 'Confirm it in your wallet…';
					const wallet = createWalletClient({ account, chain, transport: custom(window.ethereum) });
					const hash = await wallet.writeContract({ ...call, value });
					out.innerHTML = 'Sent. Waiting for it to be confirmed… <a target="_blank" rel="noopener" href="' + CONFIG.explorer + '/tx/' + hash + '">view</a>';
					const receipt = await reader.waitForTransactionReceipt({ hash });
					out.className = receipt.status === 'success' ? 'ok' : 'bad';
					out.innerHTML = (receipt.status === 'success' ? 'Done. ' : 'It failed on chain. ') + '<a target="_blank" rel="noopener" href="' + CONFIG.explorer + '/tx/' + hash + '">View on Lightscan</a>';
					refresh();
				}
			} catch (err) {
				out.className = 'bad'; out.textContent = plain(err);
			} finally {
				button.disabled = false;
			}
		};
	}
	refresh();
	setInterval(refresh, 10000);
</script>
</body>
</html>
`;
}

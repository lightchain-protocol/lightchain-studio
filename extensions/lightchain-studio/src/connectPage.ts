/**
 * The browser-side wallet connect page served by BrowserBridge on 127.0.0.1.
 * Styled only with lightchain.ai components (site-components.css).
 * All dynamic text is set via textContent (wallet names come from extensions).
 */
export function connectPageHtml(opts: { nonce: string; networks: unknown[]; known?: { address: string; wallet: string } }): string {
	const { nonce } = opts;
	// JSON inside <script>: escape "<" so a wallet name can't close the tag.
	const known = JSON.stringify(opts.known ?? null).replace(/</g, '\\u003c');
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Lightchain Studio — Wallet</title>
<link rel="stylesheet" href="/assets/site-components.css">
<style nonce="${nonce}">
	@font-face { font-family: "Inter"; src: url("/assets/Inter-latin.woff2") format("woff2"); font-weight: 100 900; unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
	@font-face { font-family: "Inter"; src: url("/assets/Inter-latin-ext.woff2") format("woff2"); font-weight: 100 900; unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }
	html, body { margin: 0; background: #070710; }
	body { font-family: "Inter", sans-serif; font-size: 16px; line-height: 1.7; color: #7376aa; -webkit-font-smoothing: antialiased; }
	*, *::before, *::after { box-sizing: border-box; }
	h4, p { margin: 0; }
	.m-0 { margin: 0 !important; }
	.d-flex { display: flex !important; }
	.align-items-center { align-items: center !important; }
	.text-uppercase { text-transform: uppercase !important; }
	.lc-connect { container: page / inline-size; max-width: 560px; margin: 0 auto; padding: 0 16px 64px; }
	/* header.lightchain-header */
	.lc-connect__header { display: flex; align-items: center; height: 81px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); margin-bottom: 40px; }
	.lc-connect__header img { width: 176px; height: auto; }
	.lc-connect__block + .lc-connect__block { margin-top: 40px; }
	.lc-connect__text { margin-top: 12px; color: #b1b3d0; font-size: 14px; line-height: 1.5; }
	/* wallet choices: .btn-border-white-blur, stacked full width (site mobile pattern) */
	.lc-wallets { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
	.lc-wallets .btn-default { width: 100%; justify-content: flex-start; gap: 12px; cursor: pointer; }
	.lc-wallets img { width: 24px; height: 24px; border-radius: 6px; }
	/* .live-network-metrics__card */
	.lc-card { margin-top: 16px; padding: 22px; background: #020203; border: 1px solid rgba(204, 206, 239, 0.16); }
	.lc-card__value { color: #f5f6ff; font-size: 20px; font-weight: 500; line-height: 1.2; word-break: break-all; }
	.lc-card__label { margin-top: 8px; color: #b1b3d0; font-size: 14px; line-height: 1.2; }
	.lc-log { list-style: none; margin: 16px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
	.lc-log li { padding: 12px 15px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px; color: #ccceef; font-size: 14px; display: flex; justify-content: space-between; gap: 12px; }
	.lc-log .ok { color: #3eb75e; } .lc-log .err { color: #ff2a27; } .lc-log .wait { color: #ff8f3c; }
	.lc-steps { list-style: none; margin: 16px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
	.lc-steps li { padding: 12px 15px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px; color: #b1b3d0; font-size: 14px; line-height: 1.5; }
	.lc-steps li.now { border-color: rgba(204, 206, 239, 0.16); color: #f5f6ff; }
	.lc-steps li.done { color: #3eb75e; }
	[hidden] { display: none !important; }
</style>
</head>
<body>
<main class="lc-connect">
	<header class="lc-connect__header"><img src="/assets/logo.svg" alt="Lightchain AI"></header>

	<section class="lc-connect__block">
		<h4 class="lc-sm-title border-left m-0" id="title">Lightchain Studio wallet &gt;&gt;</h4>
		<p class="lc-connect__text" id="lead">Lightchain Studio uses your browser wallet for Lightchain AI sign-in, buying credits and deploying contracts. Your keys never leave your wallet.</p>
		<div class="lc-card" id="task" hidden><div class="lc-card__value" id="taskWhat"></div><div class="lc-card__label" id="taskWhy"></div></div>
		<ol class="lc-steps" id="steps" hidden>
			<li id="step1"></li>
			<li id="step2"></li>
		</ol>
	</section>

	<section class="lc-connect__block" id="choose" hidden>
		<h4 class="lc-sm-title border-left m-0">Choose your wallet &gt;&gt;</h4>
		<p class="lc-connect__text" id="chooseWhy"></p>
		<div class="lc-wallets" id="wallets"></div>
		<p class="lc-connect__text" id="none" hidden>No browser wallet found. Install a wallet extension such as MetaMask or Rabby, then reload this page.</p>
	</section>

	<section class="lc-connect__block" id="connected" hidden>
		<h4 class="lc-sm-title border-left m-0">Connected &gt;&gt;</h4>
		<div class="lc-card"><div class="lc-card__value" id="address"></div><div class="lc-card__label" id="walletName"></div></div>
	</section>

	<section class="lc-connect__block" id="requests" hidden>
		<h4 class="lc-sm-title border-left m-0">Activity &gt;&gt;</h4>
		<ul class="lc-log" id="log"></ul>
	</section>
</main>
<script nonce="${nonce}">
(() => {
	const base = location.pathname.replace(/\\/$/, '');
	const $ = id => document.getElementById(id);
	const post = body => fetch(base + '/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const KNOWN = ${known}; // the browser account Lightchain Studio already uses, if any
	const REMEMBER = 'lightchain-studio.wallet';
	const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
	const providers = new Map();
	let active = null;   // { provider, info }
	let ready = false;   // finished trying to re-attach the remembered wallet silently
	let current = null;  // request being approved right now
	const queue = [];    // requests waiting for a wallet

	// ---- what the page says --------------------------------------------------------
	const what = msg => msg.purpose || ({ personal_sign: 'Sign a message', eth_sendTransaction: 'Send a transaction' }[msg.method] || msg.method);
	const why = msg => msg.method === 'personal_sign'
		? 'A signature only proves you own this account. It sends nothing and costs no gas.'
		: 'This sends a transaction on Lightchain ' + msg.chain.chainName.replace(/^Lightchain\\s*/i, '') + '. Check the details in your wallet before approving.';
	function view() {
		const pending = current || queue[0];
		const walletName = active ? active.info.name : (KNOWN && KNOWN.wallet) || 'your wallet';
		$('task').hidden = !pending;
		$('steps').hidden = !pending;
		$('connected').hidden = !active || !!pending;
		$('choose').hidden = !!active || !ready;
		if (pending) {
			$('title').textContent = 'Lightchain Studio needs your approval >>';
			$('lead').textContent = 'Lightchain Studio asked your wallet for the following:';
			$('taskWhat').textContent = what(pending);
			$('taskWhy').textContent = why(pending);
			const s1 = $('step1'), s2 = $('step2');
			if (!active) {
				s1.className = 'now'; s1.textContent = '1. Connect ' + walletName + ' to this page — click it below.' + (KNOWN ? ' Use account ' + short(KNOWN.address) + '.' : '');
				s2.className = ''; s2.textContent = '2. Approve the request in ' + walletName + '.';
			} else {
				s1.className = 'done'; s1.textContent = '1. Connected ' + active.info.name + ' — done.';
				s2.className = 'now'; s2.textContent = '2. Approve the request in ' + active.info.name + '. If no popup appeared, click the ' + active.info.name + ' icon in your browser toolbar.';
			}
			$('chooseWhy').textContent = 'This page has not been connected to your wallet yet (one time only). Pick the same wallet you use in Lightchain Studio.';
			document.title = 'Approve · Lightchain Studio';
		} else if (active) {
			$('title').textContent = 'All set >>';
			$('lead').textContent = 'You can go back to Lightchain Studio. Keep this tab open in the background — when the IDE needs a signature, the request appears here and in your wallet.';
			document.title = 'Lightchain Studio — Wallet';
		} else {
			$('title').textContent = 'Connect your wallet >>';
			$('lead').textContent = 'Lightchain Studio uses your browser wallet for Lightchain AI sign-in, buying credits and deploying contracts. Your keys never leave your wallet.';
			$('chooseWhy').textContent = KNOWN ? 'Pick ' + KNOWN.wallet + ' and the account ' + short(KNOWN.address) + ' to continue where you left off.' : 'Pick the wallet you want to use with Lightchain Studio.';
			document.title = 'Connect · Lightchain Studio';
		}
	}

	// ---- wallets --------------------------------------------------------------------
	window.addEventListener('eip6963:announceProvider', e => {
		const { info, provider } = e.detail || {};
		if (info && provider && !providers.has(info.uuid)) { providers.set(info.uuid, { info, provider }); render(); }
	});
	window.dispatchEvent(new Event('eip6963:requestProvider'));
	function render() {
		const list = $('wallets');
		list.replaceChildren();
		const entries = [...providers.values()];
		if (!entries.length && window.ethereum) entries.push({ info: { name: 'Browser Wallet', rdns: 'injected', icon: '' }, provider: window.ethereum });
		// the wallet Lightchain Studio already uses goes first
		if (KNOWN) entries.sort((a, b) => (b.info.name === KNOWN.wallet) - (a.info.name === KNOWN.wallet));
		$('none').hidden = entries.length > 0;
		for (const entry of entries) {
			const b = document.createElement('button');
			b.className = 'btn-default text-uppercase btn-border btn-border-white-blur d-flex align-items-center';
			if (entry.info.icon && /^data:image\\//.test(entry.info.icon)) { const img = document.createElement('img'); img.src = entry.info.icon; img.alt = ''; b.appendChild(img); }
			b.appendChild(document.createTextNode('Connect ' + entry.info.name));
			b.onclick = () => connect(entry, true);
			list.appendChild(b);
		}
	}
	async function connect(entry, interactive) {
		try {
			const method = interactive ? 'eth_requestAccounts' : 'eth_accounts';
			const accounts = await entry.provider.request({ method });
			if (!accounts || !accounts.length) { if (interactive) throw new Error('No account was shared.'); return false; }
			const chainId = parseInt(await entry.provider.request({ method: 'eth_chainId' }), 16);
			active = entry;
			try { localStorage.setItem(REMEMBER, entry.info.rdns); } catch {}
			entry.provider.on?.('accountsChanged', accs => {
				post({ type: 'accountsChanged', address: accs[0] || null, wallet: entry.info.name });
				$('address').textContent = accs[0] || '';
			});
			$('address').textContent = accounts[0];
			$('walletName').textContent = entry.info.name;
			await post({ type: 'connected', address: accounts[0], chainId, wallet: entry.info.name });
			view();
			drain();
			return true;
		} catch (err) {
			if (interactive) post({ type: 'connectFailed', message: err && err.message || 'Connection rejected' });
			return false;
		}
	}
	// Re-attach silently to the remembered wallet (no popup: eth_accounts).
	setTimeout(async () => {
		let rdns = null; try { rdns = localStorage.getItem(REMEMBER); } catch {}
		render();
		const all = [...providers.values()];
		const remembered = all.find(p => p.info.rdns === rdns) || (KNOWN && all.find(p => p.info.name === KNOWN.wallet))
			|| (rdns === 'injected' && window.ethereum ? { info: { name: 'Browser Wallet', rdns: 'injected' }, provider: window.ethereum } : null);
		if (remembered) await connect(remembered, false);
		ready = true;
		view();
		drain();
	}, 400);
	async function ensureChain(provider, chain) {
		const cur = await provider.request({ method: 'eth_chainId' });
		if (parseInt(cur, 16) === parseInt(chain.chainId, 16)) return;
		try {
			await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainId }] });
		} catch (err) {
			if (err && (err.code === 4902 || err.data?.originalError?.code === 4902)) {
				await provider.request({ method: 'wallet_addEthereumChain', params: [chain] });
			} else { throw err; }
		}
	}

	// ---- requests from the IDE --------------------------------------------------------
	function logItem(text) {
		$('requests').hidden = false;
		const li = document.createElement('li');
		const name = document.createElement('span'); name.textContent = text;
		const state = document.createElement('span'); state.textContent = 'Waiting for wallet'; state.className = 'wait';
		li.append(name, state);
		$('log').prepend(li);
		return state;
	}
	async function drain() {
		view();
		if (!active || current) return;
		while (queue.length) {
			current = queue.shift();
			view();
			await handle(current);
			current = null;
		}
		view();
	}
	async function handle(msg) {
		const state = logItem(what(msg));
		try {
			if (msg.method === 'eth_sendTransaction' || msg.method === 'eth_signTypedData_v4') await ensureChain(active.provider, msg.chain);
			if (msg.expectedAddress) {
				const accs = await active.provider.request({ method: 'eth_accounts' });
				if (!accs.map(a => a.toLowerCase()).includes(msg.expectedAddress.toLowerCase())) throw new Error('Switch ' + active.info.name + ' to account ' + short(msg.expectedAddress) + ' (the one Lightchain Studio uses), then try again.');
			}
			const result = await active.provider.request({ method: msg.method, params: msg.params });
			state.textContent = 'Approved'; state.className = 'ok';
			post({ type: 'result', id: msg.id, result });
		} catch (err) {
			state.textContent = (err && err.code === 4001) ? 'Rejected' : 'Failed: ' + (err && err.message || 'error'); state.className = 'err';
			post({ type: 'error', id: msg.id, error: { code: err && err.code, message: err && err.message || 'Rejected' } });
		}
	}
	const events = new EventSource(base + '/events');
	events.onmessage = e => {
		const msg = JSON.parse(e.data);
		if (msg.type !== 'request') return;
		queue.push(msg);
		drain();
	};
	view();
})();
</script>
</body>
</html>`;
}

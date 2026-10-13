/**
 * The browser-side wallet page served by BrowserBridge on 127.0.0.1.
 * Designed as the lightchain.ai "Buy & Bridge" card (LCAIPresale
 * public/scss/header/_bridge-menu.scss): aurora frame, rounded panels, pill
 * chips, details row, gradient submit, success state. All dynamic text is set
 * via textContent (wallet names come from extensions).
 */
export function connectPageHtml(opts: { nonce: string; networks: unknown[]; known?: { address: string; wallet: string }; ideUrl?: string }): string {
	const { nonce } = opts;
	// JSON inside <script>: escape "<" so a wallet name can't close the tag.
	const known = JSON.stringify(opts.known ?? null).replace(/</g, '\\u003c');
	const ideUrl = JSON.stringify(opts.ideUrl ?? '').replace(/</g, '\\u003c');
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Lightchain Studio — Wallet</title>
<style nonce="${nonce}">
	@font-face { font-family: "Inter"; src: url("/assets/Inter-latin.woff2") format("woff2"); font-weight: 100 900; unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
	@font-face { font-family: "Inter"; src: url("/assets/Inter-latin-ext.woff2") format("woff2"); font-weight: 100 900; unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }
	:root {
		--dark: #070710; --blackest: #0f1021; --dark-primary-2: #13131e;
		--heading: #ccceef; --strong: #f5f6ff; --body: #7376aa; --label: #b1b3d0;
		--border: rgba(255, 255, 255, 0.1);
		--zap-border: rgba(112, 100, 233, 0.18); --zap-border-strong: rgba(112, 100, 233, 0.45);
		--accent: #dd00ac; --violet: #5b4bff;
		--grad: linear-gradient(90deg, #df04ae 0%, #412ffd 100%);
	}
	*, *::before, *::after { box-sizing: border-box; }
	html, body { margin: 0; min-height: 100%; background: var(--dark); }
	body { font-family: "Inter", -apple-system, BlinkMacSystemFont, sans-serif; font-size: 14px; line-height: 1.5; color: var(--body); -webkit-font-smoothing: antialiased; }
	h1, h2, p { margin: 0; }
	[hidden] { display: none !important; }
	button { font-family: inherit; }

	/* page: the hero's soft purple bloom behind one centred card */
	.page { position: relative; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 28px 16px 48px; overflow: hidden; }
	.page::before { content: ""; position: absolute; left: 68%; top: 45%; width: 900px; height: 700px; transform: translate(-50%, -50%); background: radial-gradient(closest-side, rgba(112, 48, 195, 0.28), rgba(65, 0, 147, 0.10) 55%, transparent 75%); pointer-events: none; }
	.top { position: relative; width: 100%; max-width: 1040px; display: flex; align-items: center; justify-content: space-between; padding-bottom: 18px; border-bottom: 1px solid var(--border); }
	.top img { width: 150px; height: auto; display: block; }
	.top .tag { color: var(--body); font-size: 13px; }
	.stage { position: relative; flex: 1; width: 100%; max-width: 1040px; display: grid; grid-template-columns: 1fr 460px; align-items: center; gap: 64px; padding: 56px 0; }
	@media (max-width: 940px) { .stage { grid-template-columns: 1fr; gap: 36px; justify-items: center; } .hero { text-align: center; } .hero ul { justify-content: center; } }
	/* hero: the site's headline treatment */
	.eyebrow { display: inline-block; padding-left: 10px; border-left: 3px solid var(--accent); color: var(--label); font-size: 13px; font-weight: 500; letter-spacing: -0.006em; text-transform: uppercase; }
	.hero h1 { margin: 18px 0 0; color: var(--strong); font-size: 56px; font-weight: 500; line-height: 1.02; letter-spacing: -0.045em; }
	.hero h1 .grad { display: block; background: linear-gradient(90deg, #dd00ac 0%, #7130c3 70%, #5b4bff 100%); -webkit-background-clip: text; background-clip: text; color: transparent; }
	.hero p { margin-top: 18px; max-width: 440px; color: var(--strong); opacity: .85; font-size: 16px; line-height: 1.6; }
	.hero ul { list-style: none; margin: 28px 0 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
	.hero li { display: flex; align-items: center; gap: 12px; color: var(--label); font-size: 14px; }
	.hero li i { flex: none; display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; border: 1px solid rgba(112, 100, 233, 0.24); background: var(--dark-primary-2); }
	.hero li svg { width: 15px; height: 15px; fill: none; stroke: #bc82f3; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
	.cardcol { display: flex; flex-direction: column; align-items: center; }

	/* aurora frame (.lc-bridge-menu-shell) */
	@property --angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
	.shell { --angle: 0deg; position: relative; isolation: isolate; border-radius: 18px; animation: cardIn .25s ease-out; }
	.shell::before, .shell::after { content: ""; position: absolute; border-radius: inherit; pointer-events: none; animation: spin 4.5s linear infinite; }
	.shell::before { inset: -2px; padding: 2px; z-index: 1; background: conic-gradient(from var(--angle), transparent 0deg, transparent 200deg, rgba(91, 75, 255, 0.35) 250deg, #5b4bff 290deg, #bc82f3 320deg, #dd00ac 340deg, transparent 360deg); -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); mask-composite: exclude; }
	.shell::after { inset: -16px; z-index: -1; filter: blur(22px); opacity: .75; background: conic-gradient(from var(--angle), transparent 0deg, transparent 210deg, rgba(91, 75, 255, 0.55) 280deg, rgba(188, 130, 243, 0.6) 320deg, rgba(221, 0, 172, 0.5) 345deg, transparent 360deg); }
	@keyframes spin { to { --angle: 360deg; } }
	@keyframes cardIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
	@media (prefers-reduced-motion: reduce) { .shell::before, .shell::after { animation: none; --angle: 300deg; } }

	/* card (.lc-bridge-menu) */
	.card { width: 440px; max-width: calc(100vw - 32px); padding: 16px; border-radius: 16px; background: var(--blackest); border: 1px solid var(--zap-border-strong); box-shadow: 0 0 0 1px rgba(91, 75, 255, 0.12), 0 24px 60px 8px rgba(0, 0, 0, 0.35); }
	.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 2px 2px 12px; margin-bottom: 14px; border-bottom: 1px solid var(--border); }
	.title { display: block; color: var(--heading); font-size: 16px; font-weight: 600; line-height: 1.2; }
	.subtitle { display: block; margin-top: 4px; color: var(--body); font-size: 12px; line-height: 1.35; }
	.pair { flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; margin-top: 2px; color: var(--body); font-size: 12px; }
	.chain { padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(91, 75, 255, 0.21); color: var(--heading); font-size: 11px; font-weight: 600; letter-spacing: .04em; }

	.body { display: flex; flex-direction: column; gap: 10px; }
	/* .lc-zap__panel */
	.panel { padding: 14px 16px; border-radius: 14px; border: 1px solid var(--zap-border); background: rgba(204, 206, 239, 0.03); transition: border-color .2s ease; }
	.panel.focus { border-color: var(--zap-border-strong); }
	.panel-label { margin-bottom: 8px; color: var(--body); font-size: 12px; font-weight: 500; }
	.big { color: var(--heading); font-size: 24px; font-weight: 500; line-height: 1.15; letter-spacing: -0.02em; }
	.meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; color: var(--body); font-size: 12px; }

	/* account / wallet chip (.lc-zap__chip) */
	.chip { flex-shrink: 0; display: inline-flex; align-items: center; gap: 9px; padding: 5px 14px 5px 5px; border-radius: 999px; border: 1px solid rgba(112, 100, 233, 0.24); background: var(--dark-primary-2); }
	.chip-logo { display: flex; width: 26px; height: 26px; border-radius: 50%; overflow: hidden; background: var(--dark); align-items: center; justify-content: center; }
	.chip-logo img, .chip-logo svg { width: 100%; height: 100%; display: block; object-fit: cover; }
	.chip-text { display: flex; flex-direction: column; line-height: 1.15; }
	.chip-symbol { color: var(--heading); font-size: 13px; font-weight: 600; }
	.chip-network { color: var(--body); font-size: 11px; }
	.mono { font-family: Menlo, Monaco, "Courier New", monospace; }

	/* wallet choices: panels you click */
	.wallets { display: flex; flex-direction: column; gap: 6px; }
	.wallet { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 14px; border-radius: 14px; border: 1px solid var(--zap-border); background: rgba(204, 206, 239, 0.03); color: var(--heading); text-align: left; cursor: pointer; transition: border-color .2s ease, background .2s ease, transform .2s ease; }
	.wallet:hover { border-color: var(--zap-border-strong); background: rgba(91, 75, 255, 0.06); transform: translateY(-1px); }
	.wallet img { width: 32px; height: 32px; border-radius: 9px; }
	.wallet .name { flex: 1; font-size: 15px; font-weight: 500; }
	.wallet .hint { padding: 1px 8px; border-radius: 999px; background: rgba(221, 0, 172, 0.15); color: #ff6fdc; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
	.wallet .arrow { color: var(--body); font-size: 16px; }

	/* steps */
	.steps { display: flex; flex-direction: column; gap: 0; }
	.step { display: flex; align-items: center; gap: 12px; padding: 10px 2px; color: var(--label); font-size: 13px; }
	.step + .step { border-top: 1px solid rgba(112, 100, 233, 0.12); }
	.dot { flex: none; display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--zap-border-strong); color: var(--body); font-size: 11px; font-weight: 600; }
	.step.done { color: var(--body); }
	.step.done .dot { border-color: transparent; background: rgba(221, 0, 172, 0.15); box-shadow: inset 0 0 0 1px rgba(221, 0, 172, 0.4); color: #ff6fdc; }
	.step.now { color: var(--strong); }
	.step.now .dot { border-color: var(--violet); color: var(--strong); box-shadow: 0 0 0 4px rgba(91, 75, 255, 0.15); }
	.spinner { width: 14px; height: 14px; margin-left: auto; border-radius: 50%; border: 2px solid rgba(204, 206, 239, 0.15); border-top-color: var(--heading); animation: rot .8s linear infinite; }
	@keyframes rot { to { transform: rotate(360deg); } }

	/* details (.lc-zap__details) */
	.details { border-radius: 12px; border: 1px solid var(--zap-border); background: rgba(204, 206, 239, 0.02); }
	.details-toggle { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; border: 0; background: transparent; color: var(--body); font-size: 12px; text-align: left; cursor: pointer; }
	.details-toggle .chev { transition: transform .25s ease; }
	.details.open .chev { transform: rotate(180deg); }
	.details-list { display: none; grid-template-columns: auto 1fr; gap: 6px 20px; margin: 0; padding: 10px 14px 12px; border-top: 1px solid rgba(112, 100, 233, 0.12); font-size: 12px; }
	.details.open .details-list { display: grid; }
	.details-list dt { color: var(--body); }
	.details-list dd { margin: 0; text-align: right; color: var(--heading); word-break: break-word; }

	/* notices */
	.notice { padding: 9px 14px; border-radius: 12px; border: 1px solid; font-size: 12px; line-height: 1.45; }
	.notice.warn { border-color: rgba(234, 179, 8, 0.3); background: rgba(234, 179, 8, 0.1); color: #fde68a; }
	.notice.error { border-color: rgba(239, 68, 68, 0.3); background: rgba(239, 68, 68, 0.1); color: #fecaca; word-break: break-word; }
	.notice.info { border-color: var(--zap-border); background: rgba(91, 75, 255, 0.06); color: var(--label); }

	/* submit (.btn-default.lc-zap__submit) */
	.submit { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 13px 16px; border: 0; border-radius: 12px; background: var(--grad); color: #fff; font-size: 14px; font-weight: 600; line-height: 1.3; cursor: pointer; transition: filter .3s ease, box-shadow .3s ease; text-decoration: none; }
	.submit:hover:not(:disabled) { filter: brightness(1.2); box-shadow: 0 0 20px 5px rgba(112, 100, 233, 0.15); }
	.submit:disabled { opacity: .5; cursor: default; }
	.submit.ghost { background: var(--dark-primary-2); border: 1px solid rgba(112, 100, 233, 0.24); color: var(--heading); font-weight: 500; }

	/* success (.lc-zap--done) */
	.done { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 14px 0 6px; text-align: center; }
	.done-icon { display: flex; align-items: center; justify-content: center; width: 56px; height: 56px; margin-bottom: 6px; border-radius: 50%; background: rgba(221, 0, 172, 0.15); box-shadow: inset 0 0 0 1px rgba(221, 0, 172, 0.4); color: #ff6fdc; animation: pop .35s ease-out; }
	.done-icon svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
	@keyframes pop { 0% { transform: scale(.6); opacity: 0; } 70% { transform: scale(1.06); } 100% { transform: none; opacity: 1; } }
	.done-title { color: var(--heading); font-size: 18px; font-weight: 600; }
	.done-text { margin-bottom: 8px; color: var(--body); font-size: 12px; max-width: 320px; }

	/* activity + footer */
	.activity { display: flex; flex-direction: column; gap: 0; }
	.act { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 2px; font-size: 12px; color: var(--label); }
	.act + .act { border-top: 1px solid rgba(112, 100, 233, 0.12); }
	.act .ok { color: #3eb75e; } .act .err { color: #ff6b6b; } .act .wait { color: #ffb36b; }
	.foot { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 12px; padding: 10px 8px 2px; border-top: 1px solid var(--border); color: var(--body); font-size: 12px; font-weight: 500; text-align: center; }
	.secure { position: relative; margin-top: 22px; display: flex; align-items: center; gap: 8px; color: var(--body); font-size: 12px; }
	.secure svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
</style>
</head>
<body>
<div class="page">
	<div class="top"><img src="/assets/logo.svg" alt="Lightchain"><span class="tag">Studio wallet</span></div>
	<div class="stage">
		<div class="hero">
			<span class="eyebrow">Lightchain Studio</span>
			<h1><span class="grad">Your wallet,</span>connected to Studio</h1>
			<p>Studio uses your browser wallet to sign in to Lightchain AI, top up credits and publish your apps. You approve everything here, in your own wallet.</p>
			<ul>
				<li><i><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></i>Your keys never leave your wallet</li>
				<li><i><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></i>Signing in is free — it sends nothing</li>
				<li><i><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg></i>Transactions show the amount before you approve</li>
			</ul>
		</div>
		<div class="cardcol">
			<div class="shell"><div class="card">
				<div class="head">
					<div><span class="title" id="title">Connect your wallet</span><span class="subtitle" id="subtitle"></span></div>
					<span class="pair"><span class="chain">STUDIO</span>→<span class="chain">WALLET</span></span>
				</div>
				<div class="body" id="body"></div>
				<div class="foot" id="foot">Keep this tab open — Studio asks here whenever it needs your wallet.</div>
			</div></div>
			<div class="secure"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg><span>This page runs only on your computer</span></div>
		</div>
	</div>
</div>

<script nonce="${nonce}">
(() => {
	const base = location.pathname.replace(/\\/$/, '');
	const $ = id => document.getElementById(id);
	const post = body => fetch(base + '/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const KNOWN = ${known}; // the browser account Lightchain Studio already uses, if any
	const IDE_URL = ${ideUrl};
	const REMEMBER = 'lightchain-studio.wallet';
	const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
	const providers = new Map();
	let active = null;   // { provider, info }
	let address = null;
	let ready = false;   // finished trying to re-attach the remembered wallet silently
	let current = null;  // request being approved right now
	let lastDone = null; // { title, text, ok } shown after a request completes
	let detailsOpen = false;
	const queue = [];    // requests waiting for a wallet
	const history = [];  // { label, state, cls }

	const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
	const what = msg => msg.purpose || ({ personal_sign: 'Sign in to Lightchain AI', eth_sendTransaction: 'Send a transaction' }[msg.method] || msg.method);
	const why = msg => msg.method === 'personal_sign'
		? 'A signature only proves you own this account. It sends nothing and costs nothing.'
		: 'This sends a transaction on Lightchain ' + msg.chain.chainName.replace(/^Lightchain\\s*/i, '') + '. Check the amount in your wallet before approving.';
	const network = msg => msg && msg.chain ? msg.chain.chainName : '';

	// ---- small builders -------------------------------------------------------------
	function chip(name, sub, iconSrc) {
		const c = el('span', 'chip');
		const logo = el('span', 'chip-logo');
		if (iconSrc && /^data:image\\//.test(iconSrc)) { const i = el('img'); i.src = iconSrc; i.alt = ''; logo.append(i); }
		else logo.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#5b4bff"/><path d="M7 9h10v8H7z" fill="none" stroke="#fff" stroke-width="1.6"/></svg>';
		const t = el('span', 'chip-text'); t.append(el('span', 'chip-symbol' + (/^0x/.test(name) ? ' mono' : ''), name), el('span', 'chip-network', sub));
		c.append(logo, t); return c;
	}
	function submit(label, onClick, opts) {
		const b = el(opts && opts.href ? 'a' : 'button', 'submit' + (opts && opts.ghost ? ' ghost' : ''), label);
		if (opts && opts.href) b.href = opts.href;
		if (opts && opts.disabled) b.disabled = true;
		if (onClick) b.onclick = onClick;
		return b;
	}
	function returnButton() {
		if (!IDE_URL) return el('div', 'notice info', 'You can switch back to Lightchain Studio now.');
		return submit('Return to Lightchain Studio', null, { href: IDE_URL });
	}
	function activity() {
		if (!history.length) return null;
		const d = el('div', 'details' + (detailsOpen ? ' open' : ''));
		const t = el('button', 'details-toggle'); t.append(el('span', '', 'Activity · ' + history.length), el('span', 'chev', '⌄'));
		t.onclick = () => { detailsOpen = !detailsOpen; view(); };
		const list = el('div', 'details-list'); list.style.display = detailsOpen ? 'block' : 'none';
		const box = el('div', 'activity');
		history.slice(0, 8).forEach(h => { const r = el('div', 'act'); r.append(el('span', '', h.label), el('span', h.cls, h.state)); box.append(r); });
		list.append(box); d.append(t, list); return d;
	}
	function details(msg) {
		const d = el('div', 'details' + (detailsOpen ? ' open' : ''));
		const t = el('button', 'details-toggle'); t.append(el('span', '', why(msg)), el('span', 'chev', '⌄'));
		t.onclick = () => { detailsOpen = !detailsOpen; view(); };
		const dl = el('dl', 'details-list');
		const row = (k, v) => { dl.append(el('dt', '', k), el('dd', '', v)); };
		row('Request', msg.method === 'personal_sign' ? 'Signature' : msg.method === 'eth_sendTransaction' ? 'Transaction' : msg.method);
		if (network(msg)) row('Network', network(msg));
		if (msg.expectedAddress) row('Account', short(msg.expectedAddress));
		row('Cost', msg.method === 'personal_sign' ? 'Free' : 'Shown in your wallet');
		d.append(t, dl); return d;
	}

	// ---- what the card shows ---------------------------------------------------------
	function view() {
		const pending = current || queue[0];
		const body = $('body'); body.replaceChildren();
		const walletName = active ? active.info.name : (KNOWN && KNOWN.wallet) || 'your wallet';
		if (pending) {
			$('title').textContent = what(pending);
			$('subtitle').textContent = 'Lightchain Studio is asking ' + walletName + ' for approval';
			document.title = 'Approve · Lightchain Studio';
			const p = el('div', 'panel focus');
			p.append(el('div', 'panel-label', 'Request'), el('div', 'big', what(pending)));
			const meta = el('div', 'meta'); meta.append(el('span', '', pending.method === 'personal_sign' ? 'Free · no transaction' : 'Network fee shown in wallet'));
			meta.append(chip(active && address ? short(address) : (KNOWN ? short(KNOWN.address) : 'Not connected'), active ? active.info.name : walletName, active && active.info.icon));
			p.append(meta); body.append(p);
			const steps = el('div', 'panel steps');
			const s1 = el('div', 'step ' + (active ? 'done' : 'now')); s1.append(el('span', 'dot', active ? '✓' : '1'), el('span', '', active ? 'Connected ' + active.info.name : 'Connect ' + walletName + ' below'));
			const s2 = el('div', 'step ' + (active ? 'now' : '')); s2.append(el('span', 'dot', '2'), el('span', '', 'Approve in ' + walletName));
			if (active) s2.append(el('span', 'spinner'));
			steps.append(s1, s2); body.append(steps);
			if (!active) body.append(walletList());
			else body.append(el('div', 'notice info', 'No popup? Click the ' + active.info.name + ' icon in your browser toolbar.'));
			body.append(details(pending));
			return;
		}
		if (lastDone) {
			$('title').textContent = lastDone.ok ? 'All done' : 'Not completed';
			$('subtitle').textContent = lastDone.ok ? 'Lightchain Studio has what it needs' : 'Nothing was signed or sent';
			document.title = (lastDone.ok ? 'Done' : 'Not completed') + ' · Lightchain Studio';
			const d = el('div', 'done');
			const icon = el('div', 'done-icon'); icon.innerHTML = lastDone.ok ? '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>';
			d.append(icon, el('h2', 'done-title', lastDone.title), el('p', 'done-text', lastDone.text));
			body.append(d, returnButton());
			const a = activity(); if (a) body.append(a);
			return;
		}
		if (active) {
			$('title').textContent = 'Wallet connected';
			$('subtitle').textContent = 'Lightchain Studio will ask here when it needs a signature';
			document.title = 'Connected · Lightchain Studio';
			const p = el('div', 'panel'); p.append(el('div', 'panel-label', 'Account'));
			const row = el('div', 'meta'); row.style.marginTop = '0';
			row.append(el('span', 'big mono', short(address)), chip(active.info.name, 'Browser wallet', active.info.icon));
			p.append(row); body.append(p, returnButton());
			const a = activity(); if (a) body.append(a);
			return;
		}
		$('title').textContent = 'Connect your wallet';
		$('subtitle').textContent = KNOWN ? 'Pick ' + KNOWN.wallet + ' and account ' + short(KNOWN.address) + ' to continue' : 'One time only — pick the wallet you want to use with Lightchain Studio';
		document.title = 'Connect · Lightchain Studio';
		if (!ready) { body.append(el('div', 'notice info', 'Looking for wallets in this browser…')); return; }
		body.append(walletList());
	}

	// ---- wallets --------------------------------------------------------------------
	window.addEventListener('eip6963:announceProvider', e => {
		const { info, provider } = e.detail || {};
		if (info && provider && !providers.has(info.uuid)) { providers.set(info.uuid, { info, provider }); view(); }
	});
	window.dispatchEvent(new Event('eip6963:requestProvider'));
	function walletList() {
		const entries = [...providers.values()];
		if (!entries.length && window.ethereum) entries.push({ info: { name: 'Browser Wallet', rdns: 'injected', icon: '' }, provider: window.ethereum });
		// the wallet Lightchain Studio already uses goes first
		if (KNOWN) entries.sort((a, b) => (b.info.name === KNOWN.wallet) - (a.info.name === KNOWN.wallet));
		if (!entries.length) return el('div', 'notice warn', 'No browser wallet found. Install a wallet extension such as MetaMask or Rabby, then reload this page.');
		const list = el('div', 'wallets');
		for (const entry of entries) {
			const b = el('button', 'wallet');
			if (entry.info.icon && /^data:image\\//.test(entry.info.icon)) { const img = el('img'); img.src = entry.info.icon; img.alt = ''; b.append(img); }
			b.append(el('span', 'name', entry.info.name));
			if (KNOWN && entry.info.name === KNOWN.wallet) b.append(el('span', 'hint', 'Last used'));
			b.append(el('span', 'arrow', '→'));
			b.onclick = () => connect(entry, true);
			list.append(b);
		}
		return list;
	}
	async function connect(entry, interactive) {
		try {
			const method = interactive ? 'eth_requestAccounts' : 'eth_accounts';
			const accounts = await entry.provider.request({ method });
			if (!accounts || !accounts.length) { if (interactive) throw new Error('No account was shared.'); return false; }
			const chainId = parseInt(await entry.provider.request({ method: 'eth_chainId' }), 16);
			active = entry; address = accounts[0];
			try { localStorage.setItem(REMEMBER, entry.info.rdns); } catch {}
			entry.provider.on?.('accountsChanged', accs => {
				address = accs[0] || null;
				post({ type: 'accountsChanged', address: accs[0] || null, wallet: entry.info.name });
				view();
			});
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
	async function drain() {
		view();
		if (!active || current) return;
		while (queue.length) {
			current = queue.shift();
			lastDone = null;
			view();
			await handle(current);
			current = null;
		}
		view();
	}
	async function handle(msg) {
		const entry = { label: what(msg), state: 'Waiting', cls: 'wait' };
		history.unshift(entry);
		try {
			if (msg.method === 'eth_sendTransaction' || msg.method === 'eth_signTypedData_v4') await ensureChain(active.provider, msg.chain);
			if (msg.expectedAddress) {
				const accs = await active.provider.request({ method: 'eth_accounts' });
				if (!accs.map(a => a.toLowerCase()).includes(msg.expectedAddress.toLowerCase())) throw new Error('Switch ' + active.info.name + ' to account ' + short(msg.expectedAddress) + ' (the one Lightchain Studio uses), then try again.');
			}
			const result = await active.provider.request({ method: msg.method, params: msg.params });
			entry.state = 'Approved'; entry.cls = 'ok';
			post({ type: 'result', id: msg.id, result });
			lastDone = { ok: true, title: msg.method === 'personal_sign' ? 'Signed in' : 'Approved', text: msg.method === 'personal_sign' ? 'Lightchain AI can answer your prompts now. Switch back to the IDE to continue.' : 'The transaction was sent. Lightchain Studio is following it and will show the result.' };
		} catch (err) {
			const rejected = err && err.code === 4001;
			entry.state = rejected ? 'Rejected' : 'Failed'; entry.cls = 'err';
			post({ type: 'error', id: msg.id, error: { code: err && err.code, message: err && err.message || 'Rejected' } });
			lastDone = { ok: false, title: rejected ? 'Request rejected' : 'Something went wrong', text: rejected ? 'Nothing was signed or sent. You can try again from Lightchain Studio.' : (err && err.message) || 'The wallet returned an error.' };
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

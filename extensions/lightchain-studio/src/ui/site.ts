/**
 * Lightchain's app design system, shared with the Lightchain P2P desktop app
 * (lightchain-p2p/packages/ui/src/tokens.ts and apps/chat/renderer/app.css,
 * sidebar.css). One neutral ramp, one accent for interactive states, the brand
 * gradient only on the primary button, 8px buttons, 10/12px fields and menus.
 * Studio must look like the same product, so these values are copied, not tuned.
 */
export function siteCss(fontUrl: string): string {
	return `
	@font-face { font-family: "Inter"; src: url("${fontUrl}") format("woff2"); font-weight: 100 900; }
	:root {
		--lc-surface-1: #070710; --lc-surface-2: #0f0f14; --lc-surface-3: #14152c; --lc-surface-hover: #13131e;
		--lc-text-strong: #f5f6ff; --lc-text-primary: #ccceef; --lc-text-secondary: #b1b3d0; --lc-text-tertiary: #7376aa;
		--lc-accent: #5b4bff; --lc-accent-soft: rgba(125, 82, 244, 0.2); --lc-accent-bar: #dd00ac;
		--lc-rule: rgba(255, 255, 255, 0.1); --lc-rule-strong: rgba(255, 255, 255, 0.2);
		--lc-glass: rgba(255, 255, 255, 0.14);
		--lc-grad-brand: linear-gradient(90deg, #df04ae 0%, #412ffd 100%);
		--lc-glow: 0 0 20px 5px rgba(112, 100, 233, 0.1);
		--lc-success: #3eb75e; --lc-warning: #ff8f3c; --lc-danger: #ff2a27;
		--lc-radius-sm: 6px; --lc-radius-button: 8px; --lc-radius-md: 10px; --lc-radius-group: 12px;
		--lc-motion: 200ms; --lc-motion-base: 300ms;
		/* older names used by Studio panels */
		--bg: var(--lc-surface-1); --card: var(--lc-surface-2); --raise: var(--lc-surface-3);
		--line: var(--lc-rule); --line-2: var(--lc-rule-strong);
		--t1: var(--lc-text-strong); --t2: var(--lc-text-primary); --t3: var(--lc-text-secondary); --t4: var(--lc-text-tertiary);
		--accent: var(--lc-accent-bar); --cta: var(--lc-grad-brand);
	}
	*, *::before, *::after { box-sizing: border-box; }
	body { margin: 0; background: var(--lc-surface-1); color: var(--lc-text-primary); font-family: "Inter", -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
	button, input, textarea, select { font-family: inherit; }

	/* section title: .sidebar-group-title */
	.group-title { font-size: 12px; font-weight: 600; color: var(--lc-text-primary); letter-spacing: 0.5px; text-transform: uppercase; opacity: 0.5; }
	.eyebrow { margin: 0; padding-left: 10px; border-left: 3px solid var(--lc-accent-bar); color: var(--lc-text-secondary); font-size: 12px; font-weight: 500; line-height: 1.2; text-transform: uppercase; }
	.badge { color: var(--lc-text-tertiary); font-size: 12px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; }
	.title { margin: 0; color: var(--lc-text-primary); font-size: 24px; font-weight: 600; line-height: 1.2; letter-spacing: -0.02em; }
	.lead { color: var(--lc-text-secondary); font-size: 14px; }

	/* .button: glass, hairline, uppercase; hover fills with the accent */
	.button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 40px; padding: 0 20px; border: 1px solid var(--lc-rule-strong); border-radius: var(--lc-radius-button); background: var(--lc-glass); color: var(--lc-text-primary); font-size: 14px; font-weight: 500; letter-spacing: 0.5px; text-transform: uppercase; line-height: 1; white-space: nowrap; cursor: pointer; transition: all var(--lc-motion-base) ease-in-out; }
	.button:hover:not(:disabled) { border-color: var(--lc-accent); background: var(--lc-accent); color: var(--lc-text-primary); }
	.button-sm { height: 32px; padding: 0 12px; font-size: 12px; font-weight: 400; }
	.button-xs { height: 26px; padding: 0 10px; font-size: 11px; font-weight: 400; }
	.button-block { display: flex; width: 100%; }
	.button-primary { border: 0; background: var(--lc-grad-brand); color: #fff; }
	.button-primary:hover:not(:disabled) { background: var(--lc-grad-brand); color: #fff; box-shadow: var(--lc-glow); filter: brightness(125%); }
	.button:disabled { opacity: .5; cursor: not-allowed; }
	.button svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
	/* aliases for older Studio markup */
	.btn, .cta { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 32px; padding: 0 12px; border: 1px solid var(--lc-rule-strong); border-radius: var(--lc-radius-button); background: var(--lc-glass); color: var(--lc-text-primary); font-size: 12px; font-weight: 400; letter-spacing: 0.5px; text-transform: uppercase; line-height: 1; white-space: nowrap; cursor: pointer; transition: all var(--lc-motion-base) ease-in-out; }
	.btn:hover { border-color: var(--lc-accent); background: var(--lc-accent); }
	.cta { border: 0; background: var(--lc-grad-brand); color: #fff; }
	.cta:hover { box-shadow: var(--lc-glow); filter: brightness(125%); }
	.btn.sm, .cta.sm { height: 26px; padding: 0 10px; font-size: 11px; }
	.link { padding: 0; border: 0; background: none; color: var(--lc-text-tertiary); font-size: 12px; cursor: pointer; transition: color var(--lc-motion); }
	.link:hover { color: var(--lc-text-primary); }

	/* .input: transparent, 2px edge, 10px corners; focus turns the edge accent */
	.input, .field-input { width: 100%; height: 40px; padding: 0 15px; border: 2px solid var(--lc-rule); border-radius: var(--lc-radius-md); background: transparent; color: var(--lc-text-primary); font-size: 14px; line-height: 20px; outline: none; transition: border-color var(--lc-motion-base) ease; }
	.input:focus, .field-input:focus { border-color: var(--lc-accent); }
	.input::placeholder, .field-input::placeholder { color: var(--lc-text-tertiary); }
	textarea.input, textarea.field-input { height: auto; padding: 10px 15px; resize: vertical; }
	select.input, select.field-input { appearance: none; cursor: pointer; }
	select.field-input option { background: var(--lc-surface-2); }

	/* cards */
	.card { background: var(--lc-surface-2); border: 1px solid var(--lc-rule); border-radius: var(--lc-radius-md); }
	.panel { background: var(--lc-surface-1); border: 1px solid var(--lc-rule); }

	/* checkbox: 18px, 2px edge, accent when ticked */
	.check { flex: none; display: inline-grid; place-content: center; width: 18px; height: 18px; border: 2px solid var(--lc-rule); border-radius: 2px; background: var(--lc-surface-2); color: transparent; font-size: 11px; line-height: 1; transition: all var(--lc-motion-base) ease; }
	.check.on { border-color: var(--lc-accent); background: var(--lc-accent); color: #fff; }

	/* .nav-item: the sidebar row */
	.nav-item { position: relative; display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 12px; border: 0; border-radius: var(--lc-radius-sm); background: transparent; color: var(--lc-text-primary); font-size: 14px; font-weight: 500; line-height: 20px; text-align: left; cursor: pointer; transition: all 400ms; }
	.nav-item:hover, .nav-item.is-active { background: var(--lc-surface-2); color: var(--lc-accent); }
	.nav-icon { flex: none; width: 16px; height: 16px; color: var(--lc-text-tertiary); fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; transition: all 400ms; }
	.nav-item:hover .nav-icon, .nav-item.is-active .nav-icon { color: var(--lc-accent); }
	.nav-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.nav-mark { flex: none; width: 32px; height: 32px; border-radius: var(--lc-radius-sm); overflow: hidden; background: var(--lc-surface-3); display: grid; place-items: center; }
	.nav-mark svg { width: 100%; height: 100%; display: block; }
	.nav-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
	.nav-name { font-size: 15px; color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.nav-sub { font-size: 13px; font-weight: 400; color: var(--lc-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.mono { font-family: Menlo, Monaco, "Courier New", monospace; }
	`;
}

/** The P2P app's identicon (lightchain-p2p/packages/ui/src/identicon.ts), as webview script source. */
export const IDENTICON_JS = `
	function lcIdenticon(source, px) {
		let s = String(source || '?').trim().toLowerCase(); if (s.startsWith('0x')) s = s.slice(2);
		let h = 0x811c9dc5;
		for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h = Math.imul(h ^ (c & 0xff), 0x01000193); h = Math.imul(h ^ (c >>> 8), 0x01000193); }
		h = h >>> 0; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; h = h >>> 0;
		const size = 5, cols = 3; let painted = 0; const rects = [];
		for (let y = 0; y < size; y++) for (let x = 0; x < cols; x++) {
			if (((h >>> (y * cols + x)) & 1) === 0) continue;
			painted++; rects.push('<rect x="' + x + '" y="' + y + '" width="1" height="1"/>');
			if (x !== size - 1 - x) rects.push('<rect x="' + (size - 1 - x) + '" y="' + y + '" width="1" height="1"/>');
		}
		if (!painted) rects.push('<rect x="2" y="2" width="1" height="1"/>');
		const ink = ['#5b4bff', '#dd00ac', '#ffba71'][(h >>> (size * cols)) % 3];
		return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5"' + (px ? ' width="' + px + '" height="' + px + '"' : '') + ' shape-rendering="crispEdges" aria-hidden="true"><g fill="' + ink + '">' + rects.join('') + '</g></svg>';
	}
`;

/** Testnet only: claim LCAI from the Lightchain faucet (2 LCAI per 24 h, no captcha). */
export async function claimTestnetLcai(address: string): Promise<{ ok: boolean; message: string }> {
	try {
		const res = await fetch('https://lightfaucet.ai/api/claim', {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ address, network: 'testnet' }),
			signal: AbortSignal.timeout(60_000),
		});
		const body = await res.json().catch(() => ({})) as { message?: string };
		const message = (body.message ?? (res.ok ? 'Testnet LCAI sent.' : `Faucet error (${res.status}).`)).replace(/^([^:]+):\s*/, '$1 — ');
		return { ok: res.ok, message };
	} catch {
		return { ok: false, message: 'The faucet is unreachable right now. Try lightfaucet.ai in your browser.' };
	}
}

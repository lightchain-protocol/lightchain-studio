import { LightchainNetwork } from '../networks';

/** A model served by Lightchain workers, with live availability. */
export interface LightchainModel {
	id: string;        // bytes32 model id
	name: string;      // e.g. "gpt-oss:120b"
	workers: number;   // eligible workers right now
	freeSlots?: number;
	available: boolean;
}

/** Not chat/completion models — never offered in the picker. */
const NON_CHAT = /^(tts-|.*-embedding)/i;

/**
 * Agent default: first available in this order. gpt-oss is last: its workers
 * currently stall on tool-style prompts (reasoning frames, then no answer).
 */
export const PREFERRED = ['qwen3-coder-next', 'glm-4.7-flash', 'llama3-70b', 'qwen3.6:27b', 'llama3-8b', 'gpt-oss:120b', 'gpt-oss:20b'];

export async function fetchModels(network: LightchainNetwork): Promise<LightchainModel[]> {
	const api = network.consumerApiUrl;
	const { models } = await fetch(`${api}/api/models`, { signal: AbortSignal.timeout(15_000) }).then(r => r.json()) as { models: Array<{ id: string; name: string }> };
	const chat = models.filter(m => !NON_CHAT.test(m.name));
	let availability: Record<string, { eligibleWorkers?: number; freeSlots?: number; status?: string }> = {};
	try {
		const av = await fetch(`${api}/api/workers/availability?models=${chat.map(m => m.id).join(',')}`, { signal: AbortSignal.timeout(15_000) }).then(r => r.json()) as { models?: Array<{ modelId: string; eligibleWorkers?: number; freeSlots?: number; status?: string }> };
		availability = Object.fromEntries((av.models ?? []).map(a => [a.modelId, a]));
	} catch { /* availability is best-effort */ }
	return chat
		.map(m => {
			const a = availability[m.id];
			const workers = a?.eligibleWorkers ?? 0;
			return { id: m.id, name: m.name, workers, freeSlots: (a as { freeSlots?: number } | undefined)?.freeSlots, available: a ? a.status === 'available' && workers > 0 : true };
		}); // API order, as lcai-chat-v2 lists them
}

/** The user's pick if it's available, else the best available preferred model. */
export function pickDefault(models: LightchainModel[], chosen?: string): string | undefined {
	if (chosen && models.some(m => m.name === chosen && m.available)) {
		return chosen;
	}
	return PREFERRED.find(p => models.some(m => m.name === p && m.available)) ?? models.find(m => m.available)?.name ?? chosen;
}

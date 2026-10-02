import { LightchainNetwork } from '../networks';

/** A model served by Lightchain workers, with live availability. */
export interface LightchainModel {
	id: string;        // bytes32 model id
	name: string;      // e.g. "gpt-oss:120b"
	workers: number;   // eligible workers right now
	freeSlots?: number;
	available: boolean;
}

/**
 * Models the coding agent may use: large enough to follow the tool protocol and
 * write real files. Left out: tiny models (gemma4:e2b) that claim edits without
 * making them, vision models (qwen3-vl), speech/embedding models, and gpt-oss
 * while its workers stall on tool-style prompts. A model the network adds later
 * appears only once it is added here. Also the default order (coding strength first).
 */
export const AGENT_MODELS = [
	'qwen3-coder-next', 'glm-4.7-flash', 'llama3-70b', 'qwen3.6:27b',
	'deepseek-r1:32b', 'mistral-small:24b', 'gemma4:26b', 'llama3-8b',
];
export const PREFERRED = AGENT_MODELS;

export async function fetchModels(network: LightchainNetwork): Promise<LightchainModel[]> {
	const api = network.consumerApiUrl;
	const { models } = await fetch(`${api}/api/models`, { signal: AbortSignal.timeout(15_000) }).then(r => r.json()) as { models: Array<{ id: string; name: string }> };
	const chat = models.filter(m => AGENT_MODELS.includes(m.name));
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

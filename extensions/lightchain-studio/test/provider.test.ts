import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LightchainProvider } from '../src/lightchain/provider';
import { LightchainInference } from '../src/lightchain/inference';
import type { ChatMessage } from '../src/agent/agent';

// Each LightchainInference instance is one worker session; record what each one is sent.
const sessions: string[][] = [];
const proto = LightchainInference.prototype as unknown as { prompt: (this: object, text: string) => AsyncGenerator<string> };
const seen = new WeakMap<object, string[]>();
proto.prompt = async function* (this: object, text: string) {
	let log = seen.get(this);
	if (!log) {
		log = [];
		seen.set(this, log);
		sessions.push(log);
	}
	log.push(text);
	yield 'ok '.repeat(500); // ~1.5k characters of answer
};

async function ask(p: LightchainProvider, history: ChatMessage[], text: string, request?: string) {
	history.push({ role: 'user', content: text, request });
	let answer = '';
	for await (const d of p.chat(history, new AbortController().signal)) {
		answer += d;
	}
	history.push({ role: 'assistant', content: answer });
}

test('provider: instructions once, notes after, fresh session with a recap when full', async () => {
	const wallet = { active: { address: '0x1' } } as never;
	const p = new LightchainProvider(wallet, { current: {} } as never, 'llama3-8b');
	let refreshed = 0;
	p.onRefresh = () => refreshed++;
	const history: ChatMessage[] = [{ role: 'system', content: 'AGENT RULES' }];

	await ask(p, history, 'Make a coin flip game', 'Make a coin flip game');
	assert.match(sessions[0][0], /^AGENT RULES/);

	await ask(p, history, 'add a fee', 'add a fee');
	assert.match(sessions[0][1], /^\[Session notes\]\nCurrent task: add a fee/);
	assert.doesNotMatch(sessions[0][1], /AGENT RULES/);

	// fill the session past the default 8k-token budget
	for (let i = 0; i < 12 && !refreshed; i++) {
		await ask(p, history, 'x'.repeat(4_000), `step ${i}`);
	}
	assert.equal(refreshed, 1);
	assert.equal(sessions.length, 2);
	const first = sessions[1][0];
	assert.match(first, /^AGENT RULES/);
	assert.match(first, /Earlier in this conversation \(recap/);
	assert.match(first, /User: Make a coin flip game/);
});

test('provider: project map goes with the first prompt, then only when it changes', async () => {
	const p = new LightchainProvider({ active: { address: '0x1' } } as never, { current: {} } as never, 'llama3-8b');
	const history: ChatMessage[] = [{ role: 'system', content: 'RULES', map: 'src/A.sol: contract A' }];
	const start = sessions.length;
	await ask(p, history, 'one', 'one');
	await ask(p, history, 'two', 'two');
	history[0].map = 'src/A.sol: contract A\nsrc/B.sol: contract B';
	await ask(p, history, 'three', 'three');
	const log = sessions[start];
	assert.match(log[0], /Project context \(rules[^\n]*\nsrc\/A\.sol/);
	assert.doesNotMatch(log[1], /Project context/);
	assert.match(log[2], /Project context \(updated\):\nsrc\/A\.sol: contract A\nsrc\/B\.sol/);
});

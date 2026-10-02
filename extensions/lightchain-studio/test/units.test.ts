import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimedFile, codeBlockAsWrite, parseToolCalls } from '../src/agent/agent';
import { looseReplace } from '../src/agent/tools';
import { applyHunks, lineDiff } from '../src/agent/lineDiff';
import { buildInlinePrompt, extractReplacement } from '../src/agent/inlineEdit';
import { AGENT_MODELS, fetchModels, pickDefault } from '../src/lightchain/models';
import { NETWORKS } from '../src/networks';

const fence = '```';

test('parseToolCalls: tool blocks, json tool calls, invalid JSON', () => {
	const text = `a\n${fence}tool\n{"name":"read_file","args":{"path":"src/A.sol"}}\n${fence}\nb\n${fence}json\n{"name":"forge_build","args":{}}\n${fence}\n${fence}tool\n{oops}\n${fence}`;
	const calls = parseToolCalls(text);
	assert.deepEqual(calls.map(c => c.name).sort(), ['__invalid__', 'forge_build', 'read_file']);
	assert.deepEqual(parseToolCalls(`${fence}json\n{"just": "data"}\n${fence}`), []);
});

test('codeBlockAsWrite: code block + file path becomes a write proposal', () => {
	const w = codeBlockAsWrite(`Here is \`src/Token.sol\`:\n${fence}solidity\n// SPDX-License-Identifier: MIT\ncontract Token {}\n${fence}`);
	assert.equal(w?.name, 'write_file');
	assert.equal(w?.args.path, 'src/Token.sol');
	assert.equal(codeBlockAsWrite(`${fence}bash\nforge build\n${fence}`), undefined);
});

test('claimedFile: detects claims of file changes, ignores advice', () => {
	assert.equal(claimedFile('I have created a basic `Game.sol` contract.'), 'Game.sol');
	assert.equal(claimedFile("I've written src/Token.sol with an ERC-20."), 'src/Token.sol');
	assert.equal(claimedFile('The file src/Game.sol has been created.'), 'src/Game.sol');
	assert.equal(claimedFile('Here is how you could write Game.sol yourself.'), undefined);
	assert.equal(claimedFile('I have created a plan for you.'), undefined);
});

test('looseReplace: ignores spacing and indentation, keeps file indentation', () => {
	const file = 'contract C {\n    function f() external payable {\n        require(msg.value > 0, "stake");\n    }\n}\n';
	const out = looseReplace(file, 'function f() external payable {\nrequire(msg.value>0, "stake");', 'function f() external payable {\nrequire(msg.value >= 1 ether, "stake");');
	assert.equal(out, 'contract C {\n    function f() external payable {\n        require(msg.value >= 1 ether, "stake");\n    }\n}\n');
	assert.equal(looseReplace(file, 'function g()', 'x'), undefined);       // not present
	assert.equal(looseReplace('a\nb\na\nb', 'a\nb', 'x'), undefined);       // ambiguous
});

test('lineDiff: counts and context lines', () => {
	const d = lineDiff('a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nC\nd\ne\nf\ng\n');
	assert.equal(d.added, 1);
	assert.equal(d.removed, 1);
	assert.deepEqual(d.lines.map(l => l.t), [' ', ' ', '-', '+', ' ', ' ']);
	assert.equal(lineDiff('', 'x\ny\n').added, 2);
});

test('fetchModels: only agent-capable models, availability from workers', async () => {
	const ids = { 'llama3-8b': '0x1', 'gemma4:e2b': '0x2', 'qwen3-vl:8b': '0x3', 'gpt-oss:20b': '0x4', 'qwen3-coder-next': '0x5' };
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string) => ({
		json: async () => url.includes('/availability')
			? { models: [{ modelId: '0x1', status: 'available', eligibleWorkers: 3, freeSlots: 290 }, { modelId: '0x5', status: 'busy', eligibleWorkers: 0, freeSlots: 0 }] }
			: { models: Object.entries(ids).map(([name, id]) => ({ id, name })) },
	})) as unknown as typeof fetch;
	try {
		const models = await fetchModels(NETWORKS.testnet);
		assert.deepEqual(models.map(m => m.name).sort(), ['llama3-8b', 'qwen3-coder-next']);
		assert.ok(models.every(m => AGENT_MODELS.includes(m.name)));
		assert.equal(pickDefault(models, undefined), 'llama3-8b');          // the only one with workers
		assert.equal(pickDefault(models, 'qwen3-coder-next'), 'llama3-8b'); // chosen model has no workers
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('applyHunks: keep some changes, decline others', () => {
	const before = 'a\nb\nc\nd\ne\nf\ng\nh\n';
	const after = 'a\nB\nc\nd\ne\nf\nG\nh\n';           // two separate changes
	assert.equal(lineDiff(before, after).hunks, 2);
	assert.equal(applyHunks(before, after, []), after);   // all kept
	assert.equal(applyHunks(before, after, [0, 1]), before); // all declined
	assert.equal(applyHunks(before, after, [1]), 'a\nB\nc\nd\ne\nf\ng\nh\n'); // first kept only
	assert.equal(applyHunks('', 'x\ny\n', []), 'x\ny\n');  // new file
});

test('inline edit: prompt marks the range, reply yields the replacement', () => {
	const msgs = buildInlinePrompt({ file: 'src/C.sol', language: 'solidity', text: 'a\nb\nc\n', startLine: 2, endLine: 2, instruction: 'rename' });
	assert.match(msgs[1].content, /   2 > b/);
	assert.match(msgs[1].content, /   1   a/);
	assert.equal(extractReplacement(`Sure:\n${fence}solidity\n    uint x = 1;\n${fence}\n`), '    uint x = 1;');
	assert.equal(extractReplacement('    plain reply\n'), '    plain reply');
	assert.equal(extractReplacement(`${fence}\n${fence}`), undefined);
});

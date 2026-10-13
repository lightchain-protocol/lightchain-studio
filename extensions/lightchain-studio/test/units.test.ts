import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimedFile, codeBlockAsWrite, parseToolCalls, systemPrompt } from '../src/agent/agent';
import { looseReplace, truncatedRewrite } from '../src/agent/tools';
import { applyHunks, diffOps, lineDiff } from '../src/agent/lineDiff';
import { reviewText } from '../src/editorReview';
import { projectMap } from '../src/agent/projectMap';
import { expandSlash, parseSlash } from '../src/agent/commands';
import { normalize, parseChecklist, taskPrompt } from '../src/tasks';
import { templateFor } from '../src/newProject';
import { cleanMessage, commitPrompt } from '../src/commitMessage';
import { BUILTIN_AGENTS, allowedTools, flow, normalizeProfile, profilePrompt } from '../src/agent/profiles';
import { changedFiles, estimateTokens, recap, sessionNotes } from '../src/agent/memory';
import { buildInlinePrompt, extractReplacement, trimEcho } from '../src/agent/inlineEdit';
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

test('truncatedRewrite: blocks a rewrite that drops most of a long file', () => {
	const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
	assert.match(truncatedRewrite(long, 'pragma solidity ^0.8.24;\n') ?? '', /Not written/);
	assert.equal(truncatedRewrite(long, long + '\nmore'), undefined);
	assert.equal(truncatedRewrite('a\nb\n', 'x\n'), undefined);            // short files are fine
});

test('trimEcho: a whole-file reply keeps only the new range', () => {
	const r = { file: 'R.md', language: 'markdown', text: '# T\n\nintro\nmore\n\n', startLine: 6, endLine: 6, instruction: 'add usage' };
	assert.equal(trimEcho('# T\n\nintro\nmore\n\n## Usage', r), '## Usage');
	const mid = { ...r, text: 'a\nb\nc\nd\ne\n', startLine: 3, endLine: 3 };
	assert.equal(trimEcho('a\nb\nC\nd\ne', mid), 'C');
	assert.equal(trimEcho('C', mid), 'C');
});

test('memory: session notes and recap come from the local history', () => {
	const fence3 = '```';
	const history = [
		{ role: 'system' as const, content: 'rules' },
		{ role: 'user' as const, content: 'Project context …\n\nMake a coin flip game', request: 'Make a coin flip game' },
		{ role: 'assistant' as const, content: `Creating it.\n${fence3}tool\n{"name": "write_file", "args": {"path": "src/Flip.sol", "content": "x"}}\n${fence3}` },
		{ role: 'user' as const, content: 'Result of write_file:\nWrote src/Flip.sol (40 lines).' },
		{ role: 'assistant' as const, content: 'Done: src/Flip.sol has the game.' },
		{ role: 'user' as const, content: 'add a fee', request: 'add a fee' },
	];
	assert.deepEqual(changedFiles(history), ['src/Flip.sol']);
	const notes = sessionNotes(history);
	assert.match(notes, /Current task: add a fee/);
	assert.match(notes, /Files changed so far: src\/Flip\.sol/);
	const r = recap(history.slice(0, -1));
	assert.match(r, /User: Make a coin flip game/);
	assert.match(r, /You: Creating it\. \[write_file src\/Flip\.sol\]/);
	assert.match(r, /Results: write_file: Wrote src\/Flip\.sol/);
	assert.doesNotMatch(r, /Project context/);
	assert.ok(recap(history, 60).startsWith('(earlier turns omitted)'));
	assert.equal(estimateTokens('abcd'.repeat(10)), 10);
});

test('reviewText: undecided changes show both sides, decided ones only the chosen side', () => {
	const ops = diffOps('a\nb\nc\nd\ne\nf\ng\n', 'a\nB\nc\nd\ne\nf\nG\n');
	const open = reviewText(ops, new Map(), true);
	assert.equal(open.text, 'a\nb\nB\nc\nd\ne\nf\ng\nG\n');
	assert.deepEqual(open.minus, [1, 7]);
	assert.deepEqual(open.plus, [2, 8]);
	assert.deepEqual([...open.starts], [[0, 1], [1, 7]]);
	const half = reviewText(ops, new Map([[0, true]]), true);
	assert.equal(half.text, 'a\nB\nc\nd\ne\nf\ng\nG\n');
	assert.deepEqual([...half.starts], [[1, 6]]);
	assert.equal(reviewText(ops, new Map([[0, false], [1, true]]), true).text, 'a\nb\nc\nd\ne\nf\nG\n');
});

test('projectMap: external surface of each contract, deployed addresses, size cap', () => {
	const token = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/* a token */
contract Token is ERC20, Ownable {
    uint256 public constant MAX = 1e24;
    mapping(address => uint256) public minted;
    event Minted(address indexed to, uint256 amount);
    error TooMuch(uint256 asked);
    constructor(string memory name) ERC20(name, "T") {}
    function mint(address to, uint256 amount) external onlyOwner { _mint(to, amount); }
    function _check(uint256 a) internal pure returns (bool) { return a > 0; }
    function cap() public view virtual override returns (uint256) { return MAX; }
}
interface IGame { function play(uint8 side) external payable; }`;
	const map = projectMap([{ path: 'src/Token.sol', text: token }], [{ name: 'Token', address: '0x' + '1'.repeat(40) }], 'Testnet');
	assert.match(map, /src\/Token\.sol: contract Token is ERC20, Ownable/);
	assert.match(map, /var MAX: uint256/);
	assert.match(map, /var minted: mapping\(address => uint256\)/);
	assert.match(map, /fn mint\(address to, uint256 amount\) external onlyOwner/);
	assert.match(map, /fn cap\(\) public view returns \(uint256\)/);
	assert.doesNotMatch(map, /_check/);
	assert.match(map, /event Minted\(address indexed to, uint256 amount\)/);
	assert.match(map, /error TooMuch/);
	assert.match(map, /interface IGame\n  fn play\(uint8 side\) external payable/);
	assert.match(map, /Deployed on Testnet: Token 0x1{40}/);
	const many = Array.from({ length: 60 }, (_, i) => ({ path: `src/C${i}.sol`, text: token.replace(/Token/g, `T${i}`) }));
	assert.ok(projectMap(many, [], 'Testnet').length <= 3_100);
});

test('slash commands: parse, expand with scope and extra text, ignore unknown', () => {
	assert.equal(parseSlash('/audit check the fee math')?.command.name, 'audit');
	assert.equal(parseSlash('/audit check the fee math')?.extra, 'check the fee math');
	assert.equal(parseSlash('/nope do it'), undefined);
	assert.equal(parseSlash('please /audit'), undefined);
	const e = expandSlash('/audit check the fee math', 'src/Flip.sol')!;
	assert.match(e, /security review of src\/Flip\.sol/);
	assert.match(e, /Also: check the fee math$/);
	assert.match(expandSlash('/test', 'lines 3–9 of src/A.sol')!, /tests in test\/ for lines 3–9 of src\/A\.sol/);
	assert.equal(expandSlash('/deploy', 'x'), undefined); // opens the wizard instead
});

test('tasks: checklist parsing and file normalisation', () => {
	const items = parseChecklist('Here is the plan:\n- [ ] Write the Raffle contract — tickets in LCAI, weekly draw\n- [ ] **Add tests**: buying, drawing, refunds\n1. Deploy to testnet\nSome closing text.');
	assert.deepEqual(items.map(i => i.title), ['Write the Raffle contract', 'Add tests', 'Deploy to testnet']);
	assert.equal(items[0].description, 'tickets in LCAI, weekly draw');
	const f = normalize({ tasks: [{ id: 'a', title: 'x', status: 'weird', key: 4 }, { id: 'b', title: 'y', priority: 'high' }, { nope: 1 }] });
	assert.equal(f.tasks.length, 2);
	assert.equal(f.tasks[0].status, 'todo');
	assert.equal(f.tasks[1].priority, 'high');
	assert.equal(f.next, 5); // after the highest key
	assert.match(taskPrompt({ ...f.tasks[0], description: 'details' }), /^Work on task LC-4: x\n\ndetails/);
});

test('templateFor: the starter closest to a description', () => {
	assert.equal(templateFor('A weekly raffle where people buy tickets and one winner gets the pot'), 'coinflip');
	assert.equal(templateFor('An NFT collection of pixel art badges'), 'nft');
	assert.equal(templateFor('A reward token for my community with staking'), 'token');
	assert.equal(templateFor('Freelance payments held until the client approves'), 'escrow');
	assert.equal(templateFor('Something that stores a number'), 'counter');
});

test('commit message: prompt carries the diff, reply is cleaned', () => {
	const p = commitPrompt('diff --git a/src/A.sol b/src/A.sol\n+uint fee;', ['src/B.sol']);
	assert.match(p, /New files: src\/B\.sol/);
	assert.match(p, /```diff\ndiff --git/);
	assert.equal(cleanMessage('Here is the commit message:\n```\nAdd fee to A\n\n- store a fee\n```'), 'Add fee to A\n\n- store a fee');
	assert.equal(cleanMessage('"Fix the build"'), 'Fix the build');
});

test('agent profiles: tools, prompt and flow follow the switches', () => {
	const auditor = BUILTIN_AGENTS.find(a => a.id === 'auditor')!;
	assert.deepEqual(allowedTools(auditor), ['list_dir', 'read_file', 'search', 'forge_build']);
	assert.match(profilePrompt(auditor), /must not change any files/);
	const sys = systemPrompt('demo', auditor);
	assert.doesNotMatch(sys, /- write_file:/);
	assert.match(sys, /"Auditor" agent/);
	assert.match(systemPrompt('demo'), /- write_file:/); // no profile: everything
	assert.deepEqual(flow(auditor).filter(s => !s.on).map(s => s.id), ['write', 'test']);
	const p = normalizeProfile({ id: 'x', name: 'Mine', color: 'red', rules: ['a', '', 7], can: { write: true } })!;
	assert.equal(p.color, '#7130C3');
	assert.deepEqual(p.rules, ['a']);
	assert.deepEqual(p.can, { read: true, write: true, build: false, test: false, run: false });
	assert.equal(normalizeProfile({ name: 'no id' }), undefined);
});

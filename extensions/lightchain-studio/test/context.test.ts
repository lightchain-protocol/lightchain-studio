import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { formatFrontMatter, parseFrontMatter, slug, uniqueSlug } from '../src/agent/markdown';
import { AgentProfiles, BUILTIN_AGENTS, allowedTools, profileFromMarkdown, profileToMarkdown } from '../src/agent/profiles';
import { RuleStore, globToRegExp, parseRule, renderRules, ruleMatches, ruleToMarkdown } from '../src/agent/rules';
import { LocalIndex, chunkFile, renderHits, tokenize } from '../src/agent/localIndex';
import { contextFiles, mentionedRules } from '../src/agent/context';

test('front matter: scalars, booleans, inline and block lists, quotes', () => {
	const doc = parseFrontMatter('---\nname: Gas Optimizer\ncheck: false\ntools: [read, build]\ncolor: "#DD00AC"\nstarters:\n  - Where is gas wasted?\n  - "Is this loop: safe?"\nmodel:\n---\n\nFind waste.\n');
	assert.deepEqual(doc.data, { name: 'Gas Optimizer', check: false, tools: ['read', 'build'], color: '#DD00AC', starters: ['Where is gas wasted?', 'Is this loop: safe?'], model: '' });
	assert.equal(doc.body, 'Find waste.');
	assert.deepEqual(parseFrontMatter('Just text\n'), { data: {}, body: 'Just text' });
	assert.deepEqual(parseFrontMatter('---\r\ntitle: A\r\n---\r\nBody\r\n').data, { title: 'A' });
	assert.deepEqual(parseFrontMatter('---\ntools: [read, build]   # what it may do\napproval: ask # or auto\ncolor: #5B4BFF\ntitle: "A # B"\n---\nx').data, { tools: ['read', 'build'], approval: 'ask', color: '#5B4BFF', title: 'A # B' });
	// what we write, we read back
	const data = { title: 'Rule: one', apply: 'files', globs: ['src/**/*.sol', '*.t.sol'], on: true, list: ['has, comma', 'plain'] };
	assert.deepEqual(parseFrontMatter(formatFrontMatter(data, 'Body')).data, data);
});

test('slug and uniqueSlug', () => {
	assert.equal(slug('Gas Optimizer!'), 'gas-optimizer');
	assert.equal(slug('***', 'agent'), 'agent');
	assert.equal(uniqueSlug('New agent', ['new-agent', 'new-agent-2']), 'new-agent-3');
});

test('agents as Markdown: round trip keeps every setting', () => {
	for (const agent of BUILTIN_AGENTS) {
		const back = profileFromMarkdown(agent.id, profileToMarkdown(agent))!;
		const { builtin: _b, glyph: _g, ...want } = agent;
		const { glyph: _g2, ...got } = back;
		assert.deepEqual(JSON.parse(JSON.stringify(got)), want, agent.id);
	}
});

test('agents as Markdown: a hand-written file gets sensible defaults', () => {
	const p = profileFromMarkdown('gas-optimizer', '---\ndescription: Finds wasted gas\ntools: read, build\n---\nLook for storage writes in loops.\n\n## Rules\n- Never change behaviour.\n* Show the gas saved.\n\nBe brief.\n')!;
	assert.equal(p.name, 'Gas optimizer');
	assert.equal(p.summary, 'Finds wasted gas');
	assert.deepEqual(allowedTools(p), ['list_dir', 'read_file', 'search', 'forge_build']);
	assert.deepEqual(p.rules, ['Never change behaviour.', 'Show the gas saved.']);
	assert.equal(p.role, 'Look for storage writes in loops.\n\nBe brief.');
	assert.equal(p.approval, 'ask');
	// no front matter at all: a full agent whose job is the text
	const plain = profileFromMarkdown('helper', 'Help with deployments.')!;
	assert.equal(plain.role, 'Help with deployments.');
	assert.equal(plain.can.write, true);
	assert.equal(plain.can.run, false);
});

test('instructions: when they apply, Cursor fields, round trip', () => {
	assert.equal(parseRule('a', 'Use ^0.8.24.', 'f').apply, 'always');
	assert.equal(parseRule('a', '---\nglobs: src/**/*.sol, *.t.sol\n---\nx', 'f').apply, 'files');
	assert.equal(parseRule('a', '---\nalwaysApply: false\n---\nx', 'f').apply, 'manual');
	assert.equal(parseRule('a', '---\nalwaysApply: true\nglobs: [a.sol]\n---\nx', 'f').apply, 'always');
	assert.equal(parseRule('token-style', '# Token style\n\nUse OZ.', 'f').title, 'Token style');
	assert.equal(parseRule('token-style', 'Use OZ.', 'f').title, 'Token style');
	const rule = { title: 'Tests', description: 'How we test', apply: 'files' as const, globs: ['test/**', '*.t.sol'], body: 'One behaviour per test.' };
	const back = parseRule('tests', ruleToMarkdown(rule), 'f');
	assert.deepEqual({ title: back.title, description: back.description, apply: back.apply, globs: back.globs, body: back.body }, rule);
});

test('instructions: globs match workspace paths', () => {
	const yes = (g: string, p: string) => assert.ok(globToRegExp(g).test(p), `${g} should match ${p}`);
	const no = (g: string, p: string) => assert.ok(!globToRegExp(g).test(p), `${g} should not match ${p}`);
	yes('*.sol', 'src/Token.sol'); yes('*.t.sol', 'test/Token.t.sol'); no('*.t.sol', 'src/Token.sol');
	yes('src/**/*.sol', 'src/Token.sol'); yes('src/**/*.sol', 'src/a/b/Token.sol'); no('src/**/*.sol', 'test/Token.t.sol');
	yes('test/', 'test/a/B.t.sol'); yes('script/*.s.sol', 'script/Deploy.s.sol'); no('script/*.s.sol', 'script/x/Deploy.s.sol');
	yes('**/*.{ts,js}', 'web/app.ts'); no('**/*.{ts,js}', 'web/app.sol'); yes('foundry.toml', 'foundry.toml');
	const r = parseRule('t', '---\nglobs: [test/**]\n---\nx', 'f');
	assert.ok(ruleMatches(r, ['src/A.sol', 'test/A.t.sol']));
	assert.ok(!ruleMatches(r, ['src/A.sol']));
});

test('instructions: rendering respects the budget and reports what was cut', () => {
	const rules = [parseRule('a', 'A'.repeat(300), 'f'), parseRule('b', 'B'.repeat(300), 'f'), parseRule('c', 'C'.repeat(300), 'f'), parseRule('empty', '', 'f')];
	const all = renderRules(rules, 2_000);
	assert.ok(all.text.includes('[A]') && all.text.includes('C'.repeat(300)));
	assert.deepEqual(all.parts.map(p => p.cut), [false, false, false]);
	const tight = renderRules(rules, 500);
	assert.ok(tight.text.length <= 500, String(tight.text.length));
	assert.deepEqual(tight.parts.map(p => [p.id, p.cut]), [['a', false], ['b', true], ['c', true]]);
	assert.ok(tight.text.includes('(cut short)'));
	assert.ok(!tight.text.includes('CCC'));
});

const VAULT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Vault {
    address public owner;
    uint256 public feeBps;
    mapping(address => uint256) public balances;

    constructor() {
        owner = msg.sender;
    }

    /// @notice Put LCAI into the vault.
    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    /// @notice Take your LCAI out, minus the fee.
    function withdraw(uint256 amount) external {
        balances[msg.sender] -= amount;
        uint256 fee = amount * feeBps / 10_000;
        payable(msg.sender).transfer(amount - fee);
    }

    function setFee(uint256 bps) external {
        require(msg.sender == owner, "not owner");
        feeBps = bps;
    }
}
`;
const TOKEN = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Token {
    string public name = "Demo";
    mapping(address => uint256) public balanceOf;

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
}
`;

test('local search: Solidity is chunked by member, with its NatSpec', () => {
	const chunks = chunkFile('src/Vault.sol', VAULT);
	assert.deepEqual(chunks.map(c => c.label), [undefined, 'contract Vault', 'constructor', 'function deposit', 'function withdraw', 'function setFee']);
	const withdraw = chunks.find(c => c.label === 'function withdraw')!;
	assert.ok(withdraw.text.startsWith('    /// @notice Take your LCAI out'));
	assert.equal(VAULT.split('\n').slice(withdraw.start - 1, withdraw.end).join('\n').replace(/\s+$/, ''), withdraw.text);
	// every line belongs to exactly one chunk
	assert.equal(chunks.reduce((n, c) => n + (c.end - c.start + 1), 0), VAULT.split('\n').length);
});

test('local search: tokenizer splits identifiers and drops filler', () => {
	assert.deepEqual(tokenize('setFeeBps'), ['setfeebp', 'fee', 'bps']);
	assert.deepEqual(tokenize('Please add the withdrawals to my_vault'), ['withdraw', 'my_vault', 'vault']);
});

test('local search: finds the code a request is about and nothing for small talk', () => {
	const index = new LocalIndex();
	index.update([{ path: 'src/Vault.sol', text: VAULT }, { path: 'src/Token.sol', text: TOKEN }, { path: 'README.md', text: '# Demo\n\nA vault and a token for Lightchain.\n' }]);
	assert.equal(index.files, 3);
	const fee = index.search('who can change the withdraw fee?');
	assert.equal(fee[0].path, 'src/Vault.sol');
	assert.ok(fee.some(h => h.label === 'function setFee') && fee.some(h => h.label === 'function withdraw'), fee.map(h => h.label).join());
	assert.ok(fee.every(h => h.path !== 'src/Token.sol'));
	assert.equal(index.search('mint tokens to an address')[0].label, 'function mint');
	assert.deepEqual(index.search('hello, how are you today?'), []);
	assert.deepEqual(index.search('thanks!'), []);
	// files the prompt already carries are left out
	assert.ok(index.search('withdraw fee', { exclude: new Set(['src/Vault.sol']) }).every(h => h.path !== 'src/Vault.sol'));
	// budget
	assert.ok(index.search('withdraw fee owner balances deposit', { maxChars: 300 }).reduce((n, h) => n + h.text.length, 0) <= 300);
	const text = renderHits(fee);
	assert.ok(/src\/Vault\.sol lines \d+–\d+ \(function \w+\)/.test(text));
	assert.equal(renderHits([]), '');
});

test('local search: update keeps unchanged files and drops removed ones', () => {
	const index = new LocalIndex();
	index.update([{ path: 'src/Vault.sol', text: VAULT }, { path: 'src/Token.sol', text: TOKEN }]);
	const before = index.chunks;
	index.update([{ path: 'src/Vault.sol', text: VAULT }]);
	assert.ok(index.chunks < before);
	assert.deepEqual(index.search('mint tokens address'), []);
});

test('prompt context: files and instructions named by mentions', () => {
	const ctx = { file: 'src/A.sol', mentions: ['contract:Vault@src/Vault.sol', 'deployed:0xabc', 'rule:tests', 'README.md', 'src/A.sol'] };
	assert.deepEqual(contextFiles(ctx), ['src/A.sol', 'src/Vault.sol', 'README.md']);
	assert.deepEqual(mentionedRules(ctx), ['tests']);
});

/** Points the vscode mock at a real temporary folder. */
function project(): { root: string; done: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-studio-'));
	const ws = vscode.workspace as unknown as Record<string, unknown>;
	const saved = { folders: ws.workspaceFolders, fs: ws.fs, watch: ws.createFileSystemWatcher };
	ws.workspaceFolders = [{ uri: vscode.Uri.file(root) }];
	ws.createFileSystemWatcher = () => ({ onDidChange: () => ({ dispose() { } }), onDidCreate: () => ({ dispose() { } }), onDidDelete: () => ({ dispose() { } }), dispose() { } });
	ws.fs = {
		readFile: async (u: vscode.Uri) => fs.readFileSync(u.fsPath),
		writeFile: async (u: vscode.Uri, data: Uint8Array) => fs.writeFileSync(u.fsPath, data),
		createDirectory: async (u: vscode.Uri) => { fs.mkdirSync(u.fsPath, { recursive: true }); },
		delete: async (u: vscode.Uri) => fs.rmSync(u.fsPath),
		readDirectory: async (u: vscode.Uri) => fs.readdirSync(u.fsPath, { withFileTypes: true }).map(e => [e.name, e.isDirectory() ? 2 : 1]),
	};
	return { root, done: () => { ws.workspaceFolders = saved.folders; ws.fs = saved.fs; ws.createFileSystemWatcher = saved.watch; fs.rmSync(root, { recursive: true, force: true }); } };
}

test('agent store: Markdown files, hand-written agents, and agents.json moved on save', async () => {
	const { root, done } = project();
	try {
		fs.mkdirSync(path.join(root, '.lightchain/agents'), { recursive: true });
		fs.writeFileSync(path.join(root, '.lightchain/agents.json'), JSON.stringify({ version: 1, agents: [{ ...BUILTIN_AGENTS[1], builtin: undefined, name: 'Strict Auditor' }, { id: 'old-one', name: 'Old one', role: 'Legacy.', can: { read: true } }] }));
		fs.writeFileSync(path.join(root, '.lightchain/agents/gas-optimizer.md'), '---\nname: Gas Optimizer\ntools: [read]\n---\nFind wasted gas.\n');
		const store = new AgentProfiles();
		await store.ready();
		assert.deepEqual(store.all.map(p => p.id), ['builder', 'auditor', 'tester', 'explainer', 'old-one', 'gas-optimizer']);
		assert.equal(store.get('auditor').name, 'Strict Auditor');
		assert.ok(store.isCustomized('auditor'));
		assert.deepEqual(allowedTools(store.get('gas-optimizer')), ['list_dir', 'read_file', 'search']);

		// saving a legacy agent writes its Markdown file and takes it out of agents.json
		await store.put({ ...store.get('old-one'), role: 'Now in Markdown.' });
		assert.ok(fs.readFileSync(path.join(root, '.lightchain/agents/old-one.md'), 'utf8').includes('Now in Markdown.'));
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.lightchain/agents.json'), 'utf8')).agents.map((a: { id: string }) => a.id), ['auditor']);
		// resetting the edited built-in removes the last legacy entry, and the file with it
		await store.remove('auditor');
		assert.ok(!fs.existsSync(path.join(root, '.lightchain/agents.json')));
		assert.equal(store.get('auditor').name, 'Auditor');

		const id = store.newId('Gas Optimizer');
		assert.equal(id, 'gas-optimizer-2');
		await store.put({ ...BUILTIN_AGENTS[0], id, name: 'Gas Optimizer 2', builtin: undefined });
		const again = new AgentProfiles();
		await again.ready();
		assert.equal(again.get(id).name, 'Gas Optimizer 2');
		assert.deepEqual(again.get(id).can, BUILTIN_AGENTS[0].can);
		store.dispose(); again.dispose();
	} finally {
		done();
	}
});

test('instruction store: reads rules.md, AGENTS.md and the rules folder; creates, saves, removes', async () => {
	const { root, done } = project();
	try {
		fs.mkdirSync(path.join(root, '.lightchain/rules'), { recursive: true });
		fs.writeFileSync(path.join(root, '.lightchain/rules.md'), 'Use Solidity ^0.8.24.\n');
		fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n\nRun forge fmt before committing.\n');
		fs.writeFileSync(path.join(root, '.lightchain/rules/tests.md'), '---\ntitle: Tests\nglobs: [test/**]\n---\nOne behaviour per test.\n');
		fs.writeFileSync(path.join(root, '.lightchain/rules/mainnet.mdc'), '---\ndescription: Before going live\nalwaysApply: false\n---\nAudit first.\n');
		const store = new RuleStore();
		await store.ready();
		assert.deepEqual(store.all.map(r => [r.id, r.apply, !!r.fixed]), [['project-rules', 'always', true], ['agents-md', 'always', true], ['mainnet', 'manual', false], ['tests', 'files', false]]);
		assert.deepEqual(store.always().map(r => r.title), ['Project rules', 'AGENTS.md']);
		assert.deepEqual(store.scoped(['test/Vault.t.sol'], []).map(r => r.id), ['tests']);
		assert.deepEqual(store.scoped(['src/Vault.sol'], ['mainnet']).map(r => r.id), ['mainnet']);
		assert.deepEqual(store.scoped(['src/Vault.sol'], []), []);

		const made = await store.create('Token style');
		assert.equal(made.file, '.lightchain/rules/token-style.md');
		await store.put({ ...made, apply: 'files', globs: ['src/**/*.sol'], body: 'Use OpenZeppelin.' });
		const again = new RuleStore();
		await again.ready();
		const read = again.get('token-style')!;
		assert.deepEqual([read.title, read.apply, read.globs, read.body], ['Token style', 'files', ['src/**/*.sol'], 'Use OpenZeppelin.']);
		// the single-file sources stay plain Markdown
		await store.put({ ...store.get('project-rules')!, body: 'Use Solidity ^0.8.26.' });
		assert.equal(fs.readFileSync(path.join(root, '.lightchain/rules.md'), 'utf8'), 'Use Solidity ^0.8.26.\n');
		await store.remove('token-style');
		assert.ok(!fs.existsSync(path.join(root, '.lightchain/rules/token-style.md')));
		store.dispose(); again.dispose();
	} finally {
		done();
	}
});

test('agents in plain words: one access choice maps to the switches and back', async () => {
	const { accessOf, withAccess, describeAgent, profileFromDraft } = await import('../src/agent/profiles');
	const [builder, auditor, tester] = BUILTIN_AGENTS;
	assert.deepEqual([accessOf(builder), accessOf(auditor), accessOf(tester)], ['suggest', 'answer', 'auto']);
	for (const level of ['answer', 'suggest', 'auto'] as const) {
		assert.equal(accessOf(withAccess(builder, level)), level);
	}
	const readOnly = withAccess(builder, 'answer');
	assert.ok(!allowedTools(readOnly).includes('write_file') && !readOnly.check);
	assert.equal(withAccess({ ...builder, can: { ...builder.can, run: true } }, 'answer').can.run, true, 'terminal access is a separate switch');
	assert.match(describeAgent(auditor), /never changes your files/);
	assert.match(describeAgent(builder), /waits for your OK/);
	assert.match(describeAgent(tester), /on its own/);
	const made = profileFromDraft('helper', { name: 'Helper', summary: 's', role: 'r', rules: ['a'], access: 'answer', starters: [] });
	assert.deepEqual(allowedTools(made), ['list_dir', 'read_file', 'search', 'forge_build']);
	assert.deepEqual(profileFromMarkdown('helper', profileToMarkdown(made))!.can, made.can);
});

test('agents from a description: local draft is safe, AI reply is parsed strictly', async () => {
	const { draftFromText, parseDraft, draftPrompt, AGENT_TEMPLATES } = await import('../src/agent/profiles');
	const review = draftFromText('An agent that reviews my contracts for mistakes before I deploy');
	assert.equal(review.access, 'answer');
	assert.equal(review.name, 'Contract Reviewer');
	assert.equal(draftFromText('Find where my contracts waste gas and explain each saving').name, 'Gas Explainer');
	assert.equal(draftFromText('I want a helper that fixes failing tests').name, 'Test Fixer');
	assert.match(review.role, /Never change files/);
	const fixer = draftFromText('I want a helper that fixes failing tests');
	assert.equal(fixer.access, 'suggest', 'changing files always asks first unless the user chose otherwise');
	assert.equal(draftFromText('   ').name, 'New agent');
	assert.ok(draftPrompt('x'.repeat(2_000)).length < 1_600);

	const ok = parseDraft('Sure!\n```json\n{"name": "Gas Saver", "summary": "Cheaper contracts", "role": "Find wasted gas.", "rules": ["Keep behaviour", 5, ""], "access": "AUTO", "starters": ["Where is gas wasted?"]}\n```');
	assert.deepEqual(ok, { name: 'Gas Saver', summary: 'Cheaper contracts', role: 'Find wasted gas.', rules: ['Keep behaviour'], access: 'auto', starters: ['Where is gas wasted?'] });
	assert.equal(parseDraft('{"name": "X", "role": "Do it", "access": "root"}')!.access, 'suggest');
	assert.equal(parseDraft('I cannot do that.'), undefined);
	assert.equal(parseDraft('{"name": "", "role": "x"}'), undefined);
	assert.equal(parseDraft('{broken'), undefined);
	for (const t of AGENT_TEMPLATES) {
		assert.ok(t.name && t.summary && t.role && t.starters.length, t.id);
	}
});

test('write_file: writing the same content again is refused without asking the user', async () => {
	const { TOOLS } = await import('../src/agent/tools');
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-tools-')));
	try {
		let asked = 0;
		const ctx = { root, approve: async () => { asked++; return true; } } as never;
		const write = TOOLS.find(t => t.name === 'write_file')!;
		assert.ok((await write.run({ path: 'src/A.sol', content: 'contract A {}\n' }, ctx)).ok);
		const again = await write.run({ path: 'src/A.sol', content: 'contract A {}\n' }, ctx);
		assert.equal(again.ok, false);
		assert.match(again.output, /No change: src\/A\.sol already has exactly this content/);
		assert.equal(asked, 1);
		assert.ok((await write.run({ path: 'src/A.sol', content: 'contract A { uint256 x; }\n' }, ctx)).ok);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('wallet spaces: each wallet has its own agents and instructions next to the project\'s', async () => {
	const { root, done } = project();
	const walletA = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-wallet-a-'));
	const walletB = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-wallet-b-'));
	try {
		let active = walletA;
		const space = () => vscode.Uri.file(active);
		const listeners: (() => void)[] = [];
		const onSwitch = ((fn: () => void) => { listeners.push(fn); return { dispose() { } }; }) as never;
		const agents = new AgentProfiles(space, onSwitch);
		const rules = new RuleStore(space, onSwitch);
		await agents.ready(); await rules.ready();
		assert.deepEqual(agents.scopes, ['project', 'personal']);

		// one agent for the team, one just for wallet A
		await agents.put({ ...BUILTIN_AGENTS[1], id: 'team-auditor', name: 'Team Auditor', builtin: undefined }, 'project');
		await agents.put({ ...BUILTIN_AGENTS[3], id: 'my-tutor', name: 'My Tutor', builtin: undefined }, 'personal');
		assert.ok(fs.existsSync(path.join(root, '.lightchain/agents/team-auditor.md')));
		assert.ok(fs.existsSync(path.join(walletA, 'agents/my-tutor.md')));
		assert.ok(!fs.existsSync(path.join(root, '.lightchain/agents/my-tutor.md')), 'a personal agent never lands in the project');
		assert.deepEqual(agents.all.filter(a => a.scope).map(a => [a.id, a.scope]), [['my-tutor', 'personal'], ['team-auditor', 'project']]);
		assert.equal(agents.fileOf('my-tutor')!.fsPath, path.join(walletA, 'agents/my-tutor.md'));

		const mine = await rules.create('How I like it', 'personal');
		await rules.put({ ...mine, body: 'Explain every change in one sentence.' });
		const team = await rules.create('House style', 'project');
		assert.equal(mine.file, 'Your wallet · how-i-like-it.md');
		assert.ok(fs.existsSync(path.join(walletA, 'rules/how-i-like-it.md')) && fs.existsSync(path.join(root, '.lightchain/rules/house-style.md')));
		assert.deepEqual(rules.always().map(r => [r.id, r.scope]), [['how-i-like-it', 'personal'], ['house-style', 'project']]);

		// another wallet: the project's things stay, the personal ones are that wallet's own
		active = walletB; listeners.forEach(fn => fn());
		await agents.ready(); await rules.ready();
		assert.deepEqual(agents.all.filter(a => a.scope).map(a => a.id), ['team-auditor']);
		assert.deepEqual(rules.all.map(r => r.id), ['house-style']);
		await agents.put({ ...BUILTIN_AGENTS[0], id: 'my-tutor', name: 'B Tutor', builtin: undefined }, 'personal');
		active = walletA; listeners.forEach(fn => fn());
		await agents.ready(); await rules.ready();
		assert.equal(agents.get('my-tutor').name, 'My Tutor');
		assert.equal(rules.get('how-i-like-it')!.body, 'Explain every change in one sentence.');

		// moving between the wallet and the project keeps one copy
		await agents.put(agents.get('my-tutor'), 'project');
		assert.ok(fs.existsSync(path.join(root, '.lightchain/agents/my-tutor.md')) && !fs.existsSync(path.join(walletA, 'agents/my-tutor.md')));
		await rules.put({ ...rules.get('house-style')!, scope: 'personal' });
		assert.ok(fs.existsSync(path.join(walletA, 'rules/house-style.md')) && !fs.existsSync(path.join(root, '.lightchain/rules/house-style.md')));
		assert.equal(rules.get('house-style')!.file, 'Your wallet · house-style.md');
		await agents.remove('my-tutor');
		assert.ok(!fs.existsSync(path.join(root, '.lightchain/agents/my-tutor.md')));
		agents.dispose(); rules.dispose();
	} finally {
		done();
		fs.rmSync(walletA, { recursive: true, force: true }); fs.rmSync(walletB, { recursive: true, force: true });
	}
});

test('wallet spaces: chats and project lists are kept per wallet', async () => {
	const { ChatStore } = await import('../src/agent/chatStore');
	const { touchProject } = await import('../src/walletSpace');
	const data = new Map<string, unknown>();
	const state = { get: (k: string, d?: unknown) => data.has(k) ? data.get(k) : d, update: async (k: string, v: unknown) => { v === undefined ? data.delete(k) : data.set(k, v); }, keys: () => [...data.keys()] } as never;
	let wallet: string | undefined;
	const chats = new ChatStore(state, () => wallet);
	chats.record({ type: 'user', text: 'before wallets' });
	wallet = '0xaaa';
	assert.deepEqual(chats.all().map(c => c.title), ['before wallets'], 'older chats stay visible to the first wallet');
	await chats.startNew();
	chats.record({ type: 'user', text: 'from wallet A' });
	wallet = '0xbbb';
	assert.deepEqual(chats.all().map(c => c.title), ['before wallets']);
	await chats.startNew();
	chats.record({ type: 'user', text: 'from wallet B' });
	assert.ok(chats.all().some(c => c.title === 'from wallet B') && !chats.all().some(c => c.title === 'from wallet A'));
	assert.equal(chats.current()?.title, 'from wallet B');
	wallet = '0xaaa';
	assert.ok(chats.all().some(c => c.title === 'from wallet A') && !chats.all().some(c => c.title === 'from wallet B'));
	assert.equal(chats.current()?.title, 'from wallet A');

	const list = touchProject([{ path: 'file:///a', name: 'a', last: 1 }, { path: 'file:///b', name: 'b', last: 2 }], { path: 'file:///a', name: 'a', last: 3 });
	assert.deepEqual(list.map(p => p.path), ['file:///a', 'file:///b']);
	assert.equal(touchProject(list, { path: 'file:///c', name: 'c', last: 4 }, 2).length, 2);
});

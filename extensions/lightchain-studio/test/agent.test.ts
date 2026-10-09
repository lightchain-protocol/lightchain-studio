import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent, AgentStuckError, ChatMessage, InferenceProvider } from '../src/agent/agent';

const fence = '```';
const tool = (o: object) => `${fence}tool\n${JSON.stringify(o)}\n${fence}`;

/** A scripted model: returns the given replies in order and records the prompts it saw. */
function fakeModel(replies: string[]) {
	const seen: string[] = [];
	let n = 0;
	const provider: InferenceProvider = {
		name: 'fake',
		async *chat(messages: ChatMessage[]) {
			seen.push(messages[messages.length - 1].content);
			yield replies[n++] ?? 'Done.';
		},
	};
	return { provider, seen, calls: () => n };
}

/** A project dir plus a fake `forge` that fails while a .sol file contains "= 1 }" (a missing semicolon). */
function project() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-agent-')));
	fs.mkdirSync(path.join(root, 'src'));
	const forge = path.join(root, 'fake-forge.sh');
	fs.writeFileSync(forge, '#!/bin/sh\nif grep -q "= 1 }" src/*.sol 2>/dev/null; then echo "Error (2314): Expected \';\' but got \'}\'"; exit 1; fi\necho "Compiler run successful!"\n', { mode: 0o755 });
	return { root, forge };
}

function events(log: string[]) {
	return {
		onText() { }, onTurnEnd() { log.push('turnEnd'); },
		onToolStart(c: { name: string }) { log.push(`start ${c.name}`); },
		onToolEnd(c: { name: string }, r: { ok: boolean }, soft?: boolean) { log.push(`end ${c.name} ${r.ok ? 'ok' : 'fail'}${soft ? ' soft' : ''}`); },
		onStatus() { },
	};
}

test('build-and-fix: a broken write is compiled, fixed by the model, then compiles', async () => {
	const { root, forge } = project();
	const bad = 'pragma solidity ^0.8.24;\ncontract Bad { uint x = 1 }\n';
	const good = 'pragma solidity ^0.8.24;\ncontract Bad { uint x = 1; }\n';
	const m = fakeModel([
		tool({ name: 'write_file', args: { path: 'src/Bad.sol', content: bad } }),
		'Done.',
		tool({ name: 'write_file', args: { path: 'src/Bad.sol', content: good } }),
		'Fixed.',
	]);
	const writes: string[] = [];
	const log: string[] = [];
	const agent = new Agent(m.provider, { root, forgePath: forge, approve: async () => true, onWrite: (p, before) => writes.push(`${before === undefined ? 'new' : 'overwrite'} ${path.basename(p)}`) });
	await agent.run('make a contract', events(log), new AbortController().signal);
	assert.deepEqual(log, ['start write_file', 'end write_file ok', 'start forge_build', 'end forge_build fail', 'start write_file', 'end write_file ok', 'start forge_build', 'end forge_build ok', 'turnEnd']);
	assert.match(m.seen[2], /forge build failed/);
	assert.deepEqual(writes, ['new Bad.sol', 'overwrite Bad.sol']);
	assert.equal(fs.readFileSync(path.join(root, 'src/Bad.sol'), 'utf8'), good);
});

test('partial edits are not offered: edit_file is a soft slip and the model is told to use write_file', async () => {
	const { root } = project();
	const m = fakeModel([tool({ name: 'edit_file', args: { path: 'src/A.sol', old: 'x', new: 'y' } }), 'OK.']);
	const log: string[] = [];
	await new Agent(m.provider, { root, approve: async () => true }).run('change it', events(log), new AbortController().signal);
	assert.deepEqual(log, ['end edit_file fail soft', 'turnEnd']);
	assert.match(m.seen[1], /edit_file is not available.*write_file/s);
});

test('a model that keeps failing is stopped after 3 failed steps', async () => {
	const { root } = project();
	const m = fakeModel(Array(10).fill(tool({ name: 'no_such_tool', args: {} })));
	await assert.rejects(
		new Agent(m.provider, { root, approve: async () => true }).run('do it', events([]), new AbortController().signal),
		AgentStuckError);
	assert.equal(m.calls(), 3);
});

test('a reply that claims a file change without writing it gets one nudge', async () => {
	const { root } = project();
	const m = fakeModel(['I have created `src/Game.sol` for you.', 'Sorry, here it is.']);
	await new Agent(m.provider, { root, approve: async () => true }).run('make a game', events([]), new AbortController().signal);
	assert.equal(m.calls(), 2);
	assert.match(m.seen[1], /no write_file call was made/);
});

test('a rejected write is reported to the model and nothing is written', async () => {
	const { root } = project();
	const m = fakeModel([tool({ name: 'write_file', args: { path: 'src/A.sol', content: 'x' } }), 'OK.']);
	await new Agent(m.provider, { root, approve: async () => false }).run('write', events([]), new AbortController().signal);
	assert.equal(fs.existsSync(path.join(root, 'src/A.sol')), false);
	assert.match(m.seen[1], /rejected/);
});

test('test-and-fix: after a successful build the tests run, and a failure goes back to the model', async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-agent-')));
	fs.mkdirSync(path.join(root, 'src'));
	fs.mkdirSync(path.join(root, 'test'));
	fs.writeFileSync(path.join(root, 'test/Fee.t.sol'), '// test\n');
	// builds always pass; tests fail while the fee is 10
	const forge = path.join(root, 'fake-forge.sh');
	fs.writeFileSync(forge, '#!/bin/sh\nif [ "$1" = "test" ]; then if grep -q "fee = 10" src/*.sol; then echo "[FAIL: assertion failed: 10 != 5] test_fee()"; exit 1; fi; echo "Suite result: ok. 1 passed"; exit 0; fi\necho "Compiler run successful!"\n', { mode: 0o755 });
	const m = fakeModel([
		tool({ name: 'write_file', args: { path: 'src/Fee.sol', content: 'contract Fee { uint fee = 10; }\n' } }),
		'Done.',
		tool({ name: 'write_file', args: { path: 'src/Fee.sol', content: 'contract Fee { uint fee = 5; }\n' } }),
		'Fixed: the code was wrong.',
	]);
	const log: string[] = [];
	const agent = new Agent(m.provider, { root, forgePath: forge, approve: async () => true });
	await agent.run('add a fee', events(log), new AbortController().signal);
	assert.deepEqual(log, [
		'start write_file', 'end write_file ok', 'start forge_build', 'end forge_build ok', 'start forge_test', 'end forge_test fail',
		'start write_file', 'end write_file ok', 'start forge_build', 'end forge_build ok', 'start forge_test', 'end forge_test ok', 'turnEnd',
	]);
	assert.match(m.seen[2], /forge test failed:[\s\S]*10 != 5/);
});

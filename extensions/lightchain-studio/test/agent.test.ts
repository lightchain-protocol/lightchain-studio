import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent, AgentStuckError, ChatMessage, InferenceProvider } from '../src/agent/agent';
import { BUILTIN_AGENTS } from '../src/agent/profiles';

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

test('profiles are enforced: a read-only agent cannot write, even if the model tries', async () => {
	const { root, forge } = project();
	const auditor = BUILTIN_AGENTS.find(a => a.id === 'auditor')!;
	const m = fakeModel([
		tool({ name: 'write_file', args: { path: 'src/Evil.sol', content: 'contract Evil {}' } }),
		'Finding: no issues of high severity.',
	]);
	const log: string[] = [];
	const agent = new Agent(m.provider, { root, forgePath: forge, approve: async () => true }, auditor);
	await agent.run('audit src', events(log), new AbortController().signal);
	assert.deepEqual(log, ['end write_file fail soft', 'turnEnd']);
	assert.match(m.seen[1], /not available to this agent/);
	assert.equal(fs.existsSync(path.join(root, 'src/Evil.sol')), false);
});

// ---- background work: its own branch and working copy --------------------------------------
import { spawnSync } from 'node:child_process';
import { branchFor, discardWork, git, mergeWork, notReady, runInBackground } from '../src/agent/background';

function repo() {
	const { root, forge } = project();
	const run = (...args: string[]) => { const r = spawnSync('git', args, { cwd: root }); if (r.status !== 0) { throw new Error(String(r.stderr)); } };
	run('init', '-q', '-b', 'main');
	run('config', 'user.name', 'Tester'); run('config', 'user.email', 'tester@example.invalid'); run('config', 'commit.gpgsign', 'false');
	fs.writeFileSync(path.join(root, 'src', 'Counter.sol'), 'pragma solidity ^0.8.24;\ncontract Counter { uint256 public number; }\n');
	fs.writeFileSync(path.join(root, '.gitignore'), 'lib/\nfake-forge.sh\n');
	fs.mkdirSync(path.join(root, 'lib', 'forge-std'), { recursive: true });
	fs.writeFileSync(path.join(root, 'lib', 'forge-std', 'Test.sol'), '// dependency\n');
	run('add', '-A'); run('commit', '-q', '-m', 'first');
	return { root, forge, work: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-work-'))) };
}

test('background work: a task is done on its own branch; the project is untouched until it is merged', async () => {
	const { root, forge, work } = repo();
	assert.equal(await notReady(root), undefined);
	assert.equal(branchFor('LC-3', 'Add a decrement function!'), 'lightchain/lc-3-add-a-decrement-function');
	const next = 'pragma solidity ^0.8.24;\ncontract Counter { uint256 public number; function decrement() external { number--; } }\n';
	const m = fakeModel([tool({ name: 'write_file', args: { path: 'src/Counter.sol', content: next } }), tool({ name: 'run_command', args: { command: 'rm -rf /' } }), 'I added decrement() to Counter.']);
	const progress: string[] = [];
	const result = await runInBackground({ root, workDir: work, key: 'LC-3', title: 'Add a decrement function', prompt: 'Add decrement', provider: m.provider, forgePath: forge, profile: { ...BUILTIN_AGENTS[0], can: { ...BUILTIN_AGENTS[0].can, run: true } }, signal: new AbortController().signal, onProgress: t => progress.push(t) });
	assert.equal(result.ok, true, result.problem);
	assert.deepEqual(result.files, ['src/Counter.sol']);
	assert.equal(result.branch, 'lightchain/lc-3-add-a-decrement-function');
	assert.equal(result.summary, 'I added decrement() to Counter.');
	assert.ok(progress.includes('Writing src/Counter.sol') && progress.includes('Checking that it compiles'), progress.join(' | '));
	assert.ok(m.seen.some(s => /rejected|not approved|declined/i.test(s)), 'a terminal command is never run unattended');
	// the user's files and branch are as they were
	assert.ok(!fs.readFileSync(path.join(root, 'src', 'Counter.sol'), 'utf8').includes('decrement'));
	assert.equal((await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'main');
	assert.equal((await git(root, ['status', '--porcelain'])).trim(), '');
	// dependencies were linked for the build, and not committed
	assert.ok(fs.lstatSync(path.join(result.worktree, 'lib')).isSymbolicLink());
	assert.equal((await git(root, ['log', '-1', '--format=%s', result.branch])).trim(), 'LC-3: Add a decrement function');
	assert.equal((await git(root, ['show', '--name-only', '--format=', result.branch])).trim(), 'src/Counter.sol');

	const merged = await mergeWork(root, result);
	assert.equal(merged.ok, true, merged.message);
	assert.ok(fs.readFileSync(path.join(root, 'src', 'Counter.sol'), 'utf8').includes('decrement'));
	assert.ok(!fs.existsSync(result.worktree));
	assert.equal((await git(root, ['branch', '--list', result.branch])).trim(), '');
});

test('background work: a broken result is reported, a conflict is not forced, discarding leaves no trace', async () => {
	const { root, forge, work } = repo();
	const bad = 'pragma solidity ^0.8.24;\ncontract Counter { uint x = 1 }\n';
	const m = fakeModel([tool({ name: 'write_file', args: { path: 'src/Counter.sol', content: bad } }), 'Done.', 'Still done.', 'Done again.']);
	const result = await runInBackground({ root, workDir: work, key: 'LC-4', title: 'Break it', prompt: 'x', provider: m.provider, forgePath: forge, profile: BUILTIN_AGENTS[0], signal: new AbortController().signal });
	assert.equal(result.ok, false);
	assert.equal(result.problem, 'The project does not build with these changes.');
	// meanwhile the user changed the same file: the merge must not go through, and nothing is lost
	fs.writeFileSync(path.join(root, 'src', 'Counter.sol'), 'pragma solidity ^0.8.24;\ncontract Counter { uint256 public total; }\n');
	spawnSync('git', ['commit', '-qam', 'mine'], { cwd: root });
	const merged = await mergeWork(root, result);
	assert.equal(merged.ok, false);
	assert.match(merged.message, /Nothing in your project was changed/);
	assert.ok(fs.readFileSync(path.join(root, 'src', 'Counter.sol'), 'utf8').includes('total'));
	assert.equal((await git(root, ['status', '--porcelain'])).trim(), '');
	await discardWork(root, result);
	assert.ok(!fs.existsSync(result.worktree));
	assert.equal((await git(root, ['branch', '--list', 'lightchain/*'])).trim(), '');

	// a second task with the same name gets its own branch; one that changes nothing says so
	const idle = await runInBackground({ root, workDir: work, key: 'LC-5', title: 'Nothing', prompt: 'x', provider: fakeModel(['Nothing to do.']).provider, forgePath: forge, signal: new AbortController().signal });
	assert.deepEqual([idle.ok, idle.problem, idle.files], [false, 'It finished without changing any file.', []]);
	await discardWork(root, idle);
	const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-plain-'));
	assert.match((await notReady(plain))!, /not a git repository/);
});

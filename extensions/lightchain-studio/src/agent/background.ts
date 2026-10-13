import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Agent, InferenceProvider } from './agent';
import { slug } from './markdown';
import type { AgentProfile } from './profiles';

/**
 * Background work: Lightchain AI does a task on its own, on a new git branch in
 * a separate working copy (a git worktree), so the files you are editing are
 * never touched. When it is done you look at what changed, then merge it or
 * throw it away.
 *
 * It applies its changes without asking (there is nobody to ask) but never runs
 * terminal commands, and it stops after the agent's step limit.
 */
export interface Work { branch: string; worktree: string }
export interface WorkResult extends Work {
	/** Files changed on the branch, relative to the project. */
	files: string[];
	/** The agent's last answer: what it did. */
	summary: string;
	/** False when it failed, was stopped, or left the build or tests failing. */
	ok: boolean;
	problem?: string;
	steps: number;
}

export function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' '))) : resolve(stdout)));
}

/** Why a project cannot take background work right now; undefined when it can. */
export async function notReady(root: string): Promise<string | undefined> {
	if (!await git(root, ['rev-parse', '--is-inside-work-tree']).then(o => o.trim() === 'true', () => false)) {
		return 'Background work keeps its changes on a separate git branch, and this project is not a git repository yet.';
	}
	if (!await git(root, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false)) {
		return 'Background work starts from your last commit, and this project has no commit yet. Commit your files first.';
	}
	return undefined;
}

export const branchFor = (key: string, title: string) => `lightchain/${slug(`${key} ${title}`, 'task').slice(0, 48)}`;

/** Folders a build needs that git usually does not track; linked into the working copy instead of copied. */
const LINKED = ['lib', 'node_modules'];

/** A fresh branch from HEAD, checked out in its own folder under `workDir`. */
export async function startWork(root: string, workDir: string, key: string, title: string): Promise<Work> {
	const taken = new Set((await git(root, ['branch', '--format=%(refname:short)'])).split('\n').map(b => b.trim()));
	const base = branchFor(key, title);
	let branch = base;
	for (let n = 2; taken.has(branch); n++) {
		branch = `${base}-${n}`;
	}
	const worktree = path.join(workDir, branch.replace(/\//g, '-'));
	fs.rmSync(worktree, { recursive: true, force: true });
	fs.mkdirSync(workDir, { recursive: true });
	await git(root, ['worktree', 'prune']);
	await git(root, ['worktree', 'add', '-b', branch, worktree, 'HEAD']);
	for (const name of LINKED) {
		if (fs.existsSync(path.join(root, name)) && !fs.existsSync(path.join(worktree, name))) {
			fs.symlinkSync(path.join(root, name), path.join(worktree, name), 'dir');
		}
	}
	return { branch, worktree };
}

async function linkedHere(worktree: string): Promise<string[]> {
	return LINKED.filter(name => { try { return fs.lstatSync(path.join(worktree, name)).isSymbolicLink(); } catch { return false; } });
}

export interface RunOptions {
	root: string;
	workDir: string;
	key: string;
	title: string;
	prompt: string;
	provider: InferenceProvider;
	forgePath?: string;
	profile?: AgentProfile;
	signal: AbortSignal;
	onProgress?: (text: string) => void;
	/** Called once the branch exists, so it can be cleaned up even if the run is interrupted. */
	onStart?: (work: Work) => void;
}

export async function runInBackground(o: RunOptions): Promise<WorkResult> {
	const work = await startWork(o.root, o.workDir, o.key, o.title);
	o.onStart?.(work);
	let steps = 0;
	let problem: string | undefined;
	const agent = new Agent(o.provider, {
		root: fs.realpathSync(work.worktree),
		forgePath: o.forgePath,
		// nobody is watching: file changes apply, terminal commands never run
		approve: async req => req.kind !== 'command',
	}, o.profile ? { ...o.profile, approval: 'auto' } : undefined);
	try {
		await agent.run(o.prompt, {
			onText() { },
			onToolStart: call => { steps++; o.onProgress?.(call.name === 'write_file' ? `Writing ${String(call.args.path ?? 'a file')}` : call.name === 'forge_build' ? 'Checking that it compiles' : call.name === 'forge_test' ? 'Running the tests' : call.name === 'read_file' ? `Reading ${String(call.args.path ?? 'a file')}` : 'Working'); },
			onToolEnd() { },
			onTurnEnd() { },
			onStatus: status => o.onProgress?.(status),
		}, o.signal);
	} catch (err) {
		problem = o.signal.aborted ? 'It was stopped before it finished.' : (err as Error).message.split('\n')[0];
	}
	if (!problem && o.signal.aborted) {
		problem = 'It was stopped before it finished.';
	}
	if (!problem && agent.lastCheck && !agent.lastCheck.ok) {
		problem = agent.lastCheck.command === 'forge test' ? 'The tests fail with these changes.' : 'The project does not build with these changes.';
	}
	// commit what it did, so the branch holds the work (linked dependency folders are never committed)
	const skip = (await linkedHere(work.worktree)).map(name => `:(exclude)${name}`);
	await git(work.worktree, ['add', '-A', '--', '.', ...skip]);
	const files = (await git(work.worktree, ['diff', '--cached', '--name-only'])).split('\n').map(f => f.trim()).filter(Boolean);
	if (files.length) {
		const message = `${o.key}: ${o.title}`.slice(0, 200);
		await git(work.worktree, ['commit', '-m', message]).catch(() => git(work.worktree, ['-c', 'user.name=Lightchain AI', '-c', 'user.email=ai@lightchain.invalid', 'commit', '-m', message]));
	} else if (!problem) {
		problem = 'It finished without changing any file.';
	}
	return { ...work, files, summary: agent.lastReply().replace(/```(?:tool|json)[^\n]*\n[\s\S]*?```/g, '').trim().slice(0, 1_500), ok: !problem, problem, steps };
}

/** Brings the branch into the project's current branch. The working copy and branch are removed when it worked. */
export async function mergeWork(root: string, work: Work): Promise<{ ok: boolean; message: string }> {
	try {
		await git(root, ['merge', '--no-ff', '--no-edit', work.branch]);
	} catch (err) {
		await git(root, ['merge', '--abort']).catch(() => undefined);
		return { ok: false, message: `The changes could not be merged automatically (${(err as Error).message.slice(0, 200)}). Nothing in your project was changed; the work is still on the branch ${work.branch}.` };
	}
	await discardWork(root, work, false);
	return { ok: true, message: `Merged ${work.branch} into your project.` };
}

/** Removes the working copy and, unless it was merged, deletes the branch with its commits. */
export async function discardWork(root: string, work: Work, unmerged = true): Promise<void> {
	await git(root, ['worktree', 'remove', '--force', work.worktree]).catch(() => fs.rmSync(work.worktree, { recursive: true, force: true }));
	await git(root, ['worktree', 'prune']).catch(() => undefined);
	await git(root, ['branch', unmerged ? '-D' : '-d', work.branch]).catch(() => undefined);
}

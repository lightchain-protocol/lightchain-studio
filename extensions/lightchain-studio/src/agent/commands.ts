/**
 * Slash commands in the Lightchain AI composer. Each expands into a full
 * instruction for the agent; `/deploy` opens the deploy wizard instead.
 */
export interface SlashCommand { name: string; hint: string; prompt?: (scope: string, extra: string) => string }

export const SLASH_COMMANDS: SlashCommand[] = [
	{
		name: 'explain', hint: 'Explain the code',
		prompt: (scope, extra) => `Explain ${scope}: what it does, how the parts fit together, and anything surprising or risky. Do not change any files.${extra}`,
	},
	{
		name: 'audit', hint: 'Security review',
		prompt: (scope, extra) => `Do a security review of ${scope} as an EVM/Solidity auditor. List concrete issues by severity (critical, high, medium, low, info), each with the file and line, why it matters and a fix. Check reentrancy, access control, input validation, arithmetic and precision, unchecked external calls, front-running and MEV, weak randomness, denial of service, ownership and upgrade risks, and event coverage. Say clearly if you find nothing serious. Do not change any files unless the user asks.${extra}`,
	},
	{
		name: 'test', hint: 'Write and run Foundry tests',
		prompt: (scope, extra) => `Write or extend Foundry tests in test/ for ${scope}: normal paths, reverts with their reasons, edge cases and events. Then run them with forge test and fix failing tests (or the code, if the code is wrong — say which).${extra}`,
	},
	{
		name: 'fix', hint: 'Fix build errors and warnings',
		prompt: (scope, extra) => `Fix the compiler errors and warnings in ${scope}. Keep behaviour the same unless a fix requires a change; explain each change briefly.${extra}`,
	},
	{
		name: 'doc', hint: 'Add NatSpec comments',
		prompt: (scope, extra) => `Add NatSpec documentation (@title, @notice, @dev, @param, @return) to ${scope} without changing any code.${extra}`,
	},
	{
		name: 'plan', hint: 'Break a goal into tasks for the board',
		prompt: (_scope, extra) => `Break this goal into 3 to 10 small, concrete tasks for a Lightchain project (EVM, Solidity, Foundry; testnet first): ${extra || 'the next steps for this project'}\n\nReply ONLY with a checklist, one task per line, in this exact form:\n- [ ] Short task title — one sentence on what done looks like\n\nOrder them so each can be done and tested on its own. Do not change any files and do not call tools.`,
	},
	{ name: 'deploy', hint: 'Deploy a contract (wizard)' },
];

/** `/audit check fees` → the command and the rest of the text; undefined when the text is not a command. */
export function parseSlash(text: string): { command: SlashCommand; extra: string } | undefined {
	const m = /^\/(\w+)\b\s*([\s\S]*)$/.exec(text.trim());
	const command = m && SLASH_COMMANDS.find(c => c.name === m[1].toLowerCase());
	return command ? { command, extra: m![2].trim() } : undefined;
}

/** The instruction a slash command sends; `scope` names the attached file/selection. */
export function expandSlash(text: string, scope: string): string | undefined {
	const parsed = parseSlash(text);
	if (!parsed?.command.prompt) {
		return undefined;
	}
	// /plan takes the goal itself; the others take extra instructions
	return parsed.command.prompt(scope, parsed.command.name === 'plan' ? parsed.extra : parsed.extra ? `\n\nAlso: ${parsed.extra}` : '');
}

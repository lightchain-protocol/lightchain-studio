import * as vscode from 'vscode';
import { NETWORKS } from './networks';

/** Scaffolds a Foundry project preconfigured for Lightchain testnet + mainnet. */
export async function newProject(): Promise<void> {
	const parent = await vscode.window.showOpenDialog({
		title: 'New Lightchain Project — choose a parent folder',
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		openLabel: 'Create Here',
	});
	if (!parent?.[0]) {
		return;
	}
	const name = await vscode.window.showInputBox({
		title: 'New Lightchain Project',
		prompt: 'Project name',
		value: 'my-lightchain-app',
		ignoreFocusOut: true,
		validateInput: v => /^[a-z0-9][a-z0-9._-]*$/i.test(v.trim()) ? undefined : 'Letters, numbers, dot, dash and underscore only',
	});
	if (!name) {
		return;
	}
	const root = vscode.Uri.joinPath(parent[0], name.trim());
	try {
		await vscode.workspace.fs.stat(root);
		vscode.window.showErrorMessage(`${root.fsPath} already exists.`);
		return;
	} catch {
		// does not exist — good
	}

	const t = NETWORKS.testnet, m = NETWORKS.mainnet;
	const files: Record<string, string> = {
		'foundry.toml': `[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.24"

[rpc_endpoints]
lightchain_testnet = "${t.rpcUrl}"
lightchain_mainnet = "${m.rpcUrl}"

# Contract verification on Lightscan (Blockscout)
[etherscan]
lightchain_testnet = { key = "lightscan", url = "${t.explorerUrl}/api", chain = ${t.chainId} }
lightchain_mainnet = { key = "lightscan", url = "${m.explorerUrl}/api", chain = ${m.chainId} }
`,
		'src/Counter.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Counter {
    uint256 public number;

    function setNumber(uint256 newNumber) external {
        number = newNumber;
    }

    function increment() external {
        number++;
    }
}
`,
		'script/Deploy.s.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {Counter} from "../src/Counter.sol";

contract Deploy is Script {
    function run() external returns (Counter counter) {
        vm.startBroadcast();
        counter = new Counter();
        vm.stopBroadcast();
    }
}
`,
		'test/Counter.t.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Counter} from "../src/Counter.sol";

contract CounterTest is Test {
    Counter counter;

    function setUp() public {
        counter = new Counter();
    }

    function test_Increment() public {
        counter.increment();
        assertEq(counter.number(), 1);
    }
}
`,
		'.gitignore': `out/
cache/
broadcast/*/31337/
.env
`,
		'README.md': `# ${name.trim()}

A Foundry project for Lightchain, created with Lightchain Studio.

## Setup

\`\`\`bash
forge install foundry-rs/forge-std
forge build
forge test
\`\`\`

## Deploy to Lightchain testnet (chain ${t.chainId})

\`\`\`bash
forge script script/Deploy.s.sol --rpc-url lightchain_testnet --broadcast --verify
\`\`\`

Deployments appear in Lightchain Studio's **Deployed Programs** panel (read from \`broadcast/\`).
Test LCAI: https://lightfaucet.ai · Explorer: ${t.explorerUrl}
`,
	};

	const encoder = new TextEncoder();
	for (const [path, content] of Object.entries(files)) {
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, path), encoder.encode(content));
	}
	await vscode.commands.executeCommand('vscode.openFolder', root, { forceNewWindow: false });
}

# Lightchain Studio

The official IDE for Lightchain AI. Write, test and deploy smart contracts, with Lightchain AI, a wallet and the Lightscan explorer built in.

Lightchain Studio is built on [Code - OSS](https://github.com/microsoft/vscode) (MIT). It keeps the editor you know and adds a Lightchain workspace. The only AI built in is Lightchain AI; no Copilot or other assistants ship with it.

## Download

Installers are attached to each [release](https://github.com/lightchain-protocol/lightchain-studio/releases):

| Platform | File | How to install |
|---|---|---|
| macOS (Apple silicon / Intel) | `LightchainStudio-<version>-darwin-arm64.dmg` / `-x64.dmg` | Open it and drag Lightchain Studio into Applications. |
| Windows (64-bit) | `LightchainStudioSetup-<version>-win32-x64.exe` | Run it once: it installs for your user without administrator rights, with a Start-menu shortcut and an uninstaller. A portable `.zip` is there too. |

The builds are not signed yet. On first launch macOS asks via System Settings → Privacy & Security → **Open Anyway**, and Windows SmartScreen via **More info** → **Run anyway**.

## Features

- **Lightchain AI agent.** It runs on Lightchain's decentralized inference: prompts are encrypted end to end and served by Lightchain workers. The agent reads your project, writes and edits files, and runs `forge build` and `forge test`, fixing what fails.
  - **Review in the file.** Proposed changes appear in the editor (removed lines red, added lines green). Accept or reject each change, or all at once (⌘⏎ / ⌘⌫). Every turn is a checkpoint you can undo.
  - **Inline edit** (⌘I) rewrites the selection in place; **Ask about selection** (⌘L) sends it to the chat; **Fix with Lightchain AI** appears on errors and after a failed build or test.
  - **Context.** The open file, selection and problems go with each prompt. **Local project search** finds the code your request is about on your machine and attaches the best matches, shown as outlined chips under your message; nothing is uploaded to build the index. `@` mentions files, contracts, deployed addresses, transaction hashes and instructions; `/explain`, `/audit`, `/test`, `/fix`, `/doc`, `/plan` and `/deploy` are shortcuts.
  - **Models.** Pick from the agent-capable models the network serves (Qwen, Llama, DeepSeek, GLM, Mistral, Gemma…) with live worker availability. A stalled worker is retried once, and other free models are suggested.
  - **Wallet and credits in the chat.** Click your credits to add more (1, 5, 10 LCAI or any amount) without leaving the panel. When a signature is waiting in your browser wallet, the chat says so and takes you there.
  - **Chat history** is kept per project. Each answer links its on-chain job on Lightscan and shows its cost.
- **Agents and Agent Studio.** *Lightchain: Open Agent Studio* is one tab for what Lightchain AI is and knows in your project:
  - **Agents.** Ready-made agents (Contract Builder, Auditor, Test Writer, Explainer) and your own. Each one is described in a plain paragraph and a step-by-step flow, and you change it with sentences and one choice: *Only answer*, *Suggest changes* or *Work on its own*. Single permissions, the AI model and example requests sit under *More settings*. Agents that only answer cannot write files.
  - **New agent.** Describe the helper you want in a sentence and *Write it for me* drafts it (Lightchain AI when a wallet is connected, a simple local draft otherwise), or start from a ready-made idea such as Code Reviewer, Gas Saver, Docs Writer, Launch Helper or Tutor.
  - **Instructions.** What every agent keeps in mind: always, only for matching files (globs), or only when you `@`-mention it. A meter shows how much of the model's small window the always-on instructions use.
  - **Project context.** What every conversation starts with (instructions, contracts, deployed addresses), the local index, and a box to try what a request would find.
  - **Everything is Markdown** in `.lightchain/`, so you can write it by hand and share it through git: one file per agent in `.lightchain/agents/` and per instruction in `.lightchain/rules/`. `.lightchain/rules.md` and a root `AGENTS.md` are read too.
- **On-chain tools built into the editor.**
  - **Security check as you type.** The mistakes that lose funds most often (reentrancy, functions anyone can call, ignored payment results, predictable randomness, tx.origin, selfdestruct, unbounded loops) show up as problems with a plain explanation and a fix; *Fix with Lightchain AI* applies it. Serious findings stop a deploy until you have seen them.
  - **Simulate before signing.** Every mainnet transaction is first tried on a private copy of the network (an anvil fork that lives for a few seconds), and the confirmation says what would change: balances, contract values, events, or why it would fail. `lightchain.simulate.before` extends this to testnet.
  - **Transaction debugger.** *Lightchain: Debug a Transaction* explains what a transaction did and, when it failed, why: the revert reason in plain words, custom errors and events decoded with your project's ABIs, the call trace when the node offers one, and a jump to the function in your code.
  - **Gas lens.** Above each contract and function in `src/`: what it costs to deploy or call, in gas and LCAI, and how that changed since the last build.
  - **Contract map.** Each contract in plain words: what anyone can do, what only the owner can, and where money moves in or out.
  - **Live dashboard.** A deployed contract's balance, current values and events, refreshed while the tab is open, with optional notifications.
  - **App for a contract.** *Lightchain: Make an App for a Contract* writes a one-file web app (`app/<Name>/index.html`) that reads the contract and calls it through a browser wallet, previews it in a tab, and lets Lightchain AI reshape it.
- **Launcher.** The search box in the title bar opens *What do you want to do?*: Lightchain actions in plain words, with files and every editor command still one step away.
- **Lightchain home** (left side bar): switch projects in one click, search your chats grouped by day, and keep the project's tasks at hand.
- **Task board.** To do / In progress / Review / Done with drag and drop, priorities and labels, stored in `.lightchain/tasks.json` so a team shares it through git. Hand a task to Lightchain AI with *Do with AI*, or let `/plan` break a goal into tasks.
- **Commit with Lightchain AI** writes a commit message for your changes into Source Control; you review it and commit.
- **Credits.** Top up and withdraw Lightchain AI credits (LCAI held in the JobRegistry contract) from the Wallet section in the Explorer, which also shows what you have spent and roughly how many requests are left. Fees of stalled jobs can be reclaimed once their window opens.
- **Wallet.**
  - Use your browser wallet (MetaMask, Rabby, Coinbase, Brave…) through a local bridge page. No WalletConnect project ID is needed.
  - Or keep local accounts in the OS keychain: create one, import a private key or recovery phrase, or export an account as a Foundry keystore.
- **Deployed Programs** (right side bar), per project and per network, testnet or mainnet:
  - Lists every contract from your Foundry broadcasts, your deployer address and manual entries.
  - ✓ marks contracts referenced anywhere in your code.
  - Open any contract on Lightscan.
  - **Interact** opens a tab with the contract's read and write functions. Reads load live values; writes are simulated before you sign.
- **Foundry built in.** *Lightchain: Build*, *Test* and *Deploy Script* run `forge` with compiler errors in Problems. *Deploy Contract…* is a wizard that offers an audit first (always on mainnet). Deploys are signed by your Lightchain wallet; forge never sees the key. Contracts can be verified on Lightscan.
- **Mainnet guard.** Every mainnet transaction asks for confirmation with its purpose, value and estimated fee.
- **New Lightchain Project.** Describe your app, or pick a template (starter, ERC-20, ERC-721, coin flip, escrow). Each comes with a contract, tests and a deploy script set up for Lightchain; a described app is reshaped by Lightchain AI once the project opens.
- **Extensions.** A curated Lightchain Marketplace section plus [Open VSX](https://open-vsx.org) for regular VS Code extensions.
- **Lightchain design.** The theme, fonts and start page follow lightchain.ai.

## Requirements

- macOS (arm64 or x64), Linux or Windows
- Node.js **24** (see `.nvmrc`) and Python 3
- Platform build tools for native modules: Xcode Command Line Tools on macOS, `build-essential` on Linux, VS Build Tools on Windows
- [Foundry](https://getfoundry.sh) for building and deploying contracts. If it's missing, the IDE offers to install it.

## Build and run

```sh
git clone https://github.com/lightchain-protocol/lightchain-studio.git
cd lightchain-studio
npm install          # installs dependencies for the IDE and its built-in extensions
npm run compile      # compiles the IDE
./scripts/code.sh    # launches Lightchain Studio from source (scripts\code.bat on Windows)
```

To open a project directly, run `./scripts/code.sh path/to/project`.

### Packaged app

```sh
./build/lightchain/package-mac.sh arm64      # macOS DMG (x64 for Intel Macs)
.\build\lightchain\package-win.ps1 x64        # Windows installer + portable zip (run on Windows)
npm run gulp vscode-linux-x64-min            # Linux build
```

The files land in `build/lightchain/out/`. Build each platform on that platform. Both are unsigned by default: macOS asks users to right-click → **Open** the first time, and Windows SmartScreen asks them to confirm. Signing and the release steps are described in [`build/lightchain/README.md`](build/lightchain/README.md).

### Releases

Pushing a tag like `v1.139.1` runs the **Release** workflow (`.github/workflows/release.yml`). It builds macOS arm64, macOS x64 and Windows x64 and creates a draft GitHub release with the DMGs, the Windows installer and zip, and their checksums.

GitHub Actions (`.github/workflows/build.yml`) installs, typechecks and compiles every push. Run it manually to also build a macOS DMG artifact.

### Lightchain extension

The Lightchain features live in `extensions/lightchain-studio`. The compiled bundle (`dist/extension.js`) is committed, so the IDE runs right after `npm run compile`. After changing its TypeScript sources (`src/`), rebuild it:

```sh
cd extensions/lightchain-studio/tools
npm install
npm run typecheck    # optional
npm test             # optional: unit tests (agent loop, parsing, diff, webviews)
npm run build        # ../src → ../dist/extension.js
```

Then reload the window (*Developer: Reload Window*).

## Agents and instructions as Markdown

An agent is a Markdown file in `.lightchain/agents/`. The file name is its id, the front matter holds its switches, the text is its job, and a `## Rules` list becomes its rules:

```markdown
---
name: Gas Optimizer
description: Finds where a contract wastes gas
tools: [read, build]        # read, write, build, test, run
approval: ask               # ask before changing files, or auto
check: false                # build and test after every change
---
Look for storage writes in loops, repeated reads of the same slot and oversized types.

## Rules
- Never change behaviour.
- Show the gas saved for each suggestion.
```

An instruction is a Markdown file in `.lightchain/rules/`:

```markdown
---
title: Testing
apply: files                # always, files or manual
globs: [test/**, "*.t.sol"]
---
One behaviour per test. Test every revert with its reason.
```

Cursor-style `alwaysApply` and `globs` fields are understood as well. Always-on instructions share 2,400 characters, because Lightchain models read a small window; Agent Studio shows what fits.

## Using Lightchain Studio

1. **Open or create a project.** On the Start page, choose *New Project*, *Open Folder* or *Clone Repository*.
2. **Connect a wallet.** Click **Connect Wallet** in the status bar (bottom left).
   - *Connect Browser Wallet* opens a local page (`http://localhost:3000`) where you pick your browser wallet once. Keep the tab open; signing requests from the IDE appear there and in your wallet.
   - Or *Create Account*, *Import Private Key* or *Import Recovery Phrase* for a local account.
3. **Get testnet LCAI.** Claim it from the Wallet section in the Explorer or the checklist in the Lightchain AI panel (or use the [Lightchain faucet](https://lightfaucet.ai) directly).
4. **Top up credits.** Use *Add credits* in the Wallet section, or run *Lightchain: Top Up Credits*. On your first prompt, Lightchain AI asks once for permission to spend your credits; approve it and your message is sent automatically.
5. **Ask Lightchain AI.** Type in the panel on the right, for example: *Create an ERC-20 token with a deploy script*. Pick an agent next to the model if you want a specific one (for example the Auditor). Review each proposed change in the file and accept or reject it.
6. **Build, test, deploy.** Use *Lightchain: Build*, *Lightchain: Test* and *Lightchain: Deploy Script* from the Command Palette (⇧⌘P). Deployed contracts appear in **Deployed Programs**; use **Interact** to call them.
7. **Plan the work.** Run *Lightchain: Open Task Board* to track tasks, and *Lightchain: Open Agent Studio* to see or change how the agents work.
8. **Switch networks.** Use the network switch in the Deployed Programs header, or run *Lightchain: Switch to Mainnet* or *Lightchain: Switch to Testnet*.

### Networks

| | Testnet | Mainnet |
|---|---|---|
| Chain ID | 8200 | 9200 |
| RPC | `https://rpc.testnet.lightchain.ai` | `https://rpc.mainnet.lightchain.ai` |
| Explorer | https://testnet.lightscan.app | https://mainnet.lightscan.app |

Network settings live in `extensions/lightchain-studio/src/networks.ts`.

## How it works

- **The IDE** is Code - OSS with the Lightchain identity, theme, layout defaults and built-in extensions configured in `product.json`. Upstream AI features (Copilot, chat agents) are disabled, and third-party AI extensions are hidden from Extensions search.
- **`extensions/lightchain-studio`** is the Lightchain built-in extension:
  - `src/lightchain/`: the Lightchain AI client.
    - Sign-in: SIWE → JWT.
    - Session: sortition picks a worker, and a session key is sealed to that worker (P-256 ECDH + AES-256-GCM).
    - Each prompt is uploaded as an encrypted blob and submitted as a job paid from prepaid credits.
    - Answers stream back over the relay WebSocket and are decrypted in the IDE.
  - `src/agent/`: the coding agent loop, its tools (read, search, write/edit with approval, `forge build`, `forge test`, commands with approval), agent profiles and instructions (Markdown with front matter), prompt context, the project map and the local search index (BM25 over code chunks), slash commands, chat history and the line diff.
  - `src/aiView.ts`: the Lightchain AI panel. `src/editorReview.ts` and `src/inlinePrompt.ts`: in-file review and ⌘I.
  - `src/agentStudio.ts`: Agent Studio (agents, instructions, project context). `src/workspaceView.ts`: the Lightchain home side bar. `src/tasks.ts`, `src/boardPanel.ts`: tasks and the board.
  - `src/walletView.ts`, `src/usage.ts`, `src/faucet.ts`: the Wallet section, spend read from JobRegistry events, and the testnet faucet claim.
  - `src/newProjectPanel.ts`, `src/templates.ts`, `src/deployWizard.ts`, `src/commitMessage.ts`: new project window, templates, deploy wizard and commit messages.
  - `src/chain/`: the on-chain tools — `security.ts` (the checks), `simulate.ts` (private fork), `txDebug.ts`, `abiIndex.ts` (decoding calls, events and reverts), `gas.ts`, `graph.ts` (contract map), `appTemplate.ts`, and their tabs.
  - `src/launcher.ts`: the title bar launcher.
  - `src/ui/site.ts`: the shared Lightchain design tokens and components for the webviews.
  - `test/`: unit tests, run with `npm test` in `tools/`.
  - `src/wallet.ts`, `src/browserBridge.ts`, `src/connectPage.ts`, `src/keystore.ts`: local accounts in SecretStorage, and the browser wallet bridge. The bridge is a loopback page that discovers wallets through EIP-6963 and relays requests over SSE/POST, protected by a token plus Host and Origin checks.
  - `src/credits.ts`: JobRegistry deposit, withdraw and delegate allowance.
  - `src/deployedPrograms.ts`, `src/interact.ts`: the Deployed Programs view and contract interaction.
  - `src/foundry.ts`, `src/signingProxy.ts`: forge tasks. Deploys go through a local JSON-RPC proxy, so the Lightchain wallet signs and forge never holds the key.
- **`extensions/hardhat-solidity`**: Solidity language support, vendored from Nomic Foundation (MIT).
- **`extensions/theme-lightchain`**: the Lightchain Dark theme.

## License

MIT. See `LICENSE.txt`. Third-party notices are in `ThirdPartyNotices.txt`.

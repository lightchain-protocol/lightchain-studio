# Security policy

Lightchain Studio handles private keys, signs transactions and sends encrypted prompts to a decentralized inference network. We take reports about any of that seriously.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Use [GitHub private vulnerability reporting](https://github.com/lightchain-protocol/lightchain-studio/security/advisories/new) for this repository. Include:

- the version (Help → About) and your OS,
- steps to reproduce or a proof of concept,
- the impact as you understand it.

We aim to acknowledge reports within 3 business days and to ship a fix or mitigation as quickly as the severity warrants. We will credit you in the release notes unless you prefer otherwise.

## Scope

In scope:

- The Lightchain extension in `extensions/lightchain-studio` (wallet, keystore, signing proxy, browser bridge, credits, inference client, agent tools).
- Product configuration in `product.json` and the Lightchain-specific changes to the editor.
- The build and release workflows in this repository.

Out of scope:

- Vulnerabilities in upstream Code - OSS. Report those to [Microsoft](https://github.com/microsoft/vscode/security/policy); we pick up fixes when we rebase.
- The Lightchain network, smart contracts and APIs. Those have their own disclosure process at [lightchain.ai](https://lightchain.ai).
- Third-party extensions installed from Open VSX.

## Supported versions

Only the latest release receives security fixes.

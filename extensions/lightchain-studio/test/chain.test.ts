import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blank, scanSolidity } from '../src/chain/security';

const rules = (src: string) => scanSolidity(src).map(f => f.rule);

test('security: comments and strings never trigger a finding, positions stay true', () => {
	const src = 'contract A {\n    // tx.origin == owner; selfdestruct(x)\n    string s = "selfdestruct(tx.origin)"; /* x.call{value: 1}("") */\n}\n';
	assert.equal(blank(src).length, src.length);
	assert.deepEqual(blank(src).split('\n').map(l => l.length), src.split('\n').map(l => l.length));
	assert.deepEqual(rules(src), []);
});

test('security: the classic mistakes are found, with the line they are on', () => {
	const src = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Vault {
    address public owner;
    mapping(address => uint256) public balances;
    address[] public users;

    function withdraw(uint256 amount) external {
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send failed");
        balances[msg.sender] -= amount;
    }

    function setOwner(address next) external {
        owner = next;
    }

    function sweep() external {
        require(tx.origin == owner, "no");
        payable(owner).send(address(this).balance);
    }

    function payAll() external {
        for (uint256 i = 0; i < users.length; i++) {
            balances[users[i]] += 1;
        }
    }

    function draw() external view returns (uint256) {
        return uint256(keccak256(abi.encodePacked(block.timestamp, msg.sender))) % users.length;
    }

    function close() external {
        require(msg.sender == owner, "not owner");
        selfdestruct(payable(owner));
    }
}
`;
	const found = scanSolidity(src);
	const at = (rule: string) => found.filter(f => f.rule === rule).map(f => f.line + 1);
	assert.deepEqual(at('reentrancy'), [10]);
	assert.deepEqual(at('open-access'), [15]);
	assert.deepEqual(at('tx-origin'), [20]);
	assert.deepEqual(at('unchecked-call'), [21]);
	assert.deepEqual(at('unbounded-loop'), [25]);
	assert.deepEqual(at('weak-randomness'), [31]);
	assert.deepEqual(at('selfdestruct'), [36]);
	assert.equal(found.length, 7, found.map(f => `${f.rule}@${f.line + 1}`).join(' '));
	const re = found.find(f => f.rule === 'reentrancy')!;
	assert.match(re.message, /balances is only updated afterwards/);
	assert.equal(src.split('\n')[re.line].slice(re.col, re.endCol), 'call{value:');
});

test('security: careful code stays quiet', () => {
	const src = `pragma solidity ^0.8.24;
contract Safe {
    address public owner;
    uint256 public constant FEE = 5;
    mapping(address => uint256) public balances;
    address[] public users;
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    function deposit() external payable { balances[msg.sender] += msg.value; }

    function withdraw(uint256 amount) external {
        balances[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send failed");
    }

    function setOwner(address next) external onlyOwner { owner = next; }
    function mint(address to) external { require(msg.sender == owner); balances[to] += 1; }
    function total() external view returns (uint256 sum) { for (uint256 i = 0; i < users.length; i++) { sum += balances[users[i]]; } }
    function isOwner() external view returns (bool) { return msg.sender == owner; }
    function age() external view returns (uint256) { return block.timestamp % 7; }
}
`;
	assert.deepEqual(scanSolidity(src).map(f => `${f.rule}@${f.line + 1}`), []);
});

test('security: old compilers and delegatecall are flagged', () => {
	assert.deepEqual(rules('pragma solidity ^0.6.12;\ncontract A { function f(address t, bytes memory d) public { (bool ok, ) = t.delegatecall(d); require(ok); } }'), ['old-compiler', 'delegatecall']);
	assert.deepEqual(rules('pragma solidity >=0.8.0 <0.9.0;\ncontract A {}'), []);
});

test('gas lens: lines for deployment and functions, cost in LCAI, change since last build', async () => {
	const { gasLines, formatCost, formatGas } = await import('../src/chain/gas');
	const src = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Vault {
    uint256 public feeBps;
    /* function hidden() external {} */
    function setFee(uint256 bps) external { feeBps = bps; }
    function total() external view returns (uint256) { return feeBps; }
    function over(uint256 a) external {}
    function over(address a) external {}
}
`;
	const now = { Vault: { creation: { totalCost: '457530' }, external: { 'setFee(uint256)': '24705', 'total()': 'infinite', 'over(uint256)': '100', 'over(address)': '200', 'feeBps()': '2426' } } };
	const before = { Vault: { creation: { totalCost: '457530' }, external: { 'setFee(uint256)': '26000' } } };
	const lines = gasLines(src, now, 5_000_000_000n, before);
	assert.deepEqual(lines.map(l => [l.line + 1, l.kind, l.name]), [[4, 'deploy', 'Vault'], [7, 'call', 'setFee'], [8, 'call', 'total']]);
	assert.equal(lines[0].title, 'Deploying costs about 457,530 gas · 0.0023 LCAI');
	assert.equal(lines[1].title, 'About 24,705 gas per call · 0.00012 LCAI (−1,295 since last build)');
	assert.match(lines[2].title, /depends on the input/);
	assert.deepEqual(gasLines(src, {}), []);
	assert.equal(gasLines(src, now)[0].title, 'Deploying costs about 457,530 gas');
	assert.equal(formatGas(1234567.4), '1,234,567');
	assert.equal(formatCost(21000, 1n), '<0.00001 LCAI');
	assert.equal(formatCost(21000, undefined), '');
	assert.equal(formatCost(2_000_000, 1_000_000_000_000n), '2.00 LCAI');
});

// ---- transaction debugger and simulation, against a local anvil chain ----------------------
import { spawn, spawnSync } from 'node:child_process';
import * as fsNode from 'node:fs';
import * as osNode from 'node:os';
import * as pathNode from 'node:path';
import { encodeFunctionData, type Abi, type Hex } from 'viem';
import { AbiIndex } from '../src/chain/abiIndex';
import { inspectTx, summarize } from '../src/chain/txDebug';
import { describeSimulation, simulate } from '../src/chain/simulate';
import { rpc } from '../src/chain/rpc';

const vault = JSON.parse(fsNode.readFileSync(pathNode.join(__dirname, '..', 'fixtures', 'Vault.json'), 'utf8')) as { name: string; abi: Abi; bytecode: Hex };
const abis = new AbiIndex([{ name: 'Vault', abi: vault.abi }]);
const data = (functionName: string, args: unknown[] = []) => encodeFunctionData({ abi: vault.abi, functionName, args } as never);

test('abi index: calls, events and revert reasons in plain words', () => {
	assert.equal(abis.decodeCall(data('setFee', [250n]))!.text, 'setFee(bps: 250)');
	assert.equal(abis.decodeCall('0xdeadbeef'), undefined);
	assert.equal(abis.decodeRevert('0x').kind, 'empty');
	const reason = abis.decodeRevert('0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000b73656e64206661696c6564000000000000000000000000000000000000000000');
	assert.deepEqual([reason.kind, reason.text], ['reason', 'send failed']);
	const panic = abis.decodeRevert('0x4e487b710000000000000000000000000000000000000000000000000000000000000011');
	assert.equal(panic.kind, 'panic');
	assert.match(panic.plain, /below zero or above its maximum/);
	assert.equal(abis.decodeRevert('0x12345678').kind, 'unknown');
});

test('transaction summary reads like a sentence', () => {
	const base = { hash: '0x1', from: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', toName: 'Vault', value: '0 LCAI', events: [], trace: [] };
	assert.equal(summarize({ ...base, status: 'success', call: abis.decodeCall(data('setFee', [250n])), fee: '0.0001 LCAI' }), '0x1111…1111 called setFee(bps: 250) on Vault, and it worked. It cost 0.0001 LCAI in fees.');
	assert.match(summarize({ ...base, status: 'failed', call: abis.decodeCall(data('withdraw', [5n])), revert: abis.decodeRevert('0x') }), /and it failed\. The contract refused the call without saying why/);
	assert.match(summarize({ ...base, status: 'failed', outOfGas: true }), /ran out of gas/);
	assert.match(summarize({ hash: '0x1', status: 'missing', events: [], trace: [] }), /not found on this network/);
});

const anvilPath = [pathNode.join(osNode.homedir(), '.foundry', 'bin', 'anvil'), 'anvil'].find(p => spawnSync(p, ['--version']).status === 0);

test('debugger and simulation on a real chain (local anvil)', { skip: !anvilPath && 'anvil is not installed' }, async () => {
	const port = 18545 + Math.floor(Math.random() * 1000);
	const url = `http://127.0.0.1:${port}`;
	const node = spawn(anvilPath!, ['--port', String(port), '--silent'], { stdio: 'ignore' });
	try {
		for (let i = 0; i < 60; i++) {
			if (await rpc(url, 'eth_chainId', [], 500).then(() => true, () => false)) { break; }
			await new Promise(r => setTimeout(r, 200));
		}
		const [owner, user] = await rpc<string[]>(url, 'eth_accounts');
		const mined = async (tx: Record<string, unknown>) => {
			const hash = await rpc<string>(url, 'eth_sendTransaction', [{ gas: '0x200000', ...tx }]);
			for (;;) {
				const receipt = await rpc<{ contractAddress: string | null; status: string } | null>(url, 'eth_getTransactionReceipt', [hash]);
				if (receipt) { return { hash, receipt }; }
				await new Promise(r => setTimeout(r, 50));
			}
		};
		const deployed = await mined({ from: owner, data: vault.bytecode });
		const address = deployed.receipt.contractAddress!;
		const names = new Map([[address.toLowerCase(), 'Vault']]);

		// --- debugger
		const deploy = await inspectTx(url, deployed.hash, abis, names);
		assert.equal(deploy.status, 'success');
		assert.match(deploy.summary, /deployed a contract, and it worked\. The new contract is at 0x/);

		const deposit = await inspectTx(url, (await mined({ from: user, to: address, data: data('deposit'), value: '0xde0b6b3a7640000' })).hash, abis, names);
		assert.equal(deposit.status, 'success');
		assert.match(deposit.summary, /called deposit\(\) on Vault, sending 1 LCAI along, and it worked/);

		const withdrawn = await inspectTx(url, (await mined({ from: user, to: address, data: data('withdraw', [10n ** 17n]) })).hash, abis, names);
		assert.deepEqual(withdrawn.events.map(e => e.text.replace(/0x[0-9a-fA-F]{40}/, '0x…')), ['Withdrawn(who: 0x…, amount: 100000000000000000)']);

		const tooMuch = await inspectTx(url, (await mined({ from: user, to: address, data: data('withdraw', [10n ** 20n]) })).hash, abis, names);
		assert.equal(tooMuch.status, 'failed');
		assert.equal(tooMuch.revert?.text, 'send failed');
		assert.match(tooMuch.summary, /called withdraw\(amount: 100000000000000000000\) on Vault, and it failed\. The contract stopped with the message "send failed"\. Nothing was changed/);

		const notOwner = await inspectTx(url, (await mined({ from: user, to: address, data: data('setFee', [1n]) })).hash, abis, names);
		assert.equal(notOwner.revert?.kind, 'custom');
		assert.match(notOwner.revert!.plain, /its own error "not owner" \(caller: 0x/);
		assert.equal((await inspectTx(url, '0x' + '00'.repeat(32), abis)).status, 'missing');

		// --- simulation: a private fork of that chain, nothing is sent to it
		const feeBefore = await rpc<string>(url, 'eth_call', [{ to: address, data: data('feeBps') }, 'latest']);
		const sim = await simulate({ rpcUrl: url, anvil: anvilPath, abis, abi: vault.abi, toLabel: 'Vault', tx: { from: owner, to: address, data: data('setFee', [250n]) } });
		assert.equal(sim.ok, true);
		assert.equal(sim.how, 'fork');
		assert.deepEqual(sim.state, [{ name: 'feeBps', before: '0', after: '250' }]);
		assert.ok(describeSimulation(sim).includes('feeBps: 0 → 250'), describeSimulation(sim).join(' | '));
		assert.equal(await rpc<string>(url, 'eth_call', [{ to: address, data: data('feeBps') }, 'latest']), feeBefore, 'the real chain is untouched');

		const pay = await simulate({ rpcUrl: url, anvil: anvilPath, abis, abi: vault.abi, toLabel: 'Vault', tx: { from: owner, to: address, data: data('deposit'), value: 2n * 10n ** 18n } });
		assert.deepEqual(pay.balances.map(b => b.label), ['Your wallet', 'Vault']);
		assert.equal(pay.balances[1].after - pay.balances[1].before, 2n * 10n ** 18n);
		const lines = describeSimulation(pay);
		assert.match(lines.join('\n'), /Your wallet: −2\.\d+ LCAI \(including about [\d.]+ LCAI in fees\)\nVault: \+2 LCAI/);

		const refused = await simulate({ rpcUrl: url, anvil: anvilPath, abis, abi: vault.abi, tx: { from: user, to: address, data: data('setFee', [1n]) } });
		assert.equal(refused.ok, false);
		assert.equal(refused.revert?.name, 'NotOwner');
		assert.equal(describeSimulation(refused)[0], 'This transaction would FAIL.');

		// without anvil: a dry run still says whether it works
		const dry = await simulate({ rpcUrl: url, abis, tx: { from: user, to: address, data: data('setFee', [1n]) } });
		assert.deepEqual([dry.ok, dry.how, dry.revert?.name], [false, 'call', 'NotOwner']);
		assert.equal((await simulate({ rpcUrl: url, abis, tx: { from: owner, to: address, data: data('setFee', [9n]) } })).ok, true);
	} finally {
		node.kill('SIGKILL');
	}
});

test('contract map: who may call what, where money moves, how contracts relate', async () => {
	const { contractMap } = await import('../src/chain/graph');
	const map = contractMap([
		{ path: 'src/Base.sol', text: 'abstract contract Base {\n    address public owner;\n    modifier onlyOwner() { require(msg.sender == owner); _; }\n    function setOwner(address o) external onlyOwner { owner = o; }\n}\n' },
		{ path: 'src/Vault.sol', text: `import "./Base.sol";
interface IToken { function transfer(address to, uint256 a) external returns (bool); }
contract Vault is Base, ReentrancyGuard {
    IToken public token;
    mapping(address => uint256) public balances;
    constructor(IToken t) { token = t; }
    function deposit() external payable { balances[msg.sender] += msg.value; }
    function withdraw(uint256 a) external { balances[msg.sender] -= a; payable(msg.sender).transfer(a); }
    function sweep() external { require(msg.sender == owner, "no"); payable(owner).transfer(address(this).balance); }
    function total() external view returns (uint256) { return address(this).balance; }
    function _helper() internal {}
}
` },
	]);
	assert.deepEqual(map.map(c => [c.name, c.kind, c.depth]), [['Base', 'abstract', 0], ['IToken', 'interface', 0], ['Vault', 'contract', 1]]);
	const v = map.find(c => c.name === 'Vault')!;
	assert.deepEqual(v.bases, ['Base', 'ReentrancyGuard']);
	assert.deepEqual(v.uses, ['IToken']);
	assert.deepEqual(v.state, ['token', 'balances']);
	assert.deepEqual(v.functions.map(f => [f.name, f.who, f.payable, f.sends, f.line]), [['deposit', 'anyone', true, false, 7], ['withdraw', 'anyone', false, true, 8], ['sweep', 'restricted', false, true, 9], ['total', 'read', false, false, 10]]);
	assert.equal(map[0].functions[0].guard, 'onlyOwner');
	assert.equal(v.functions[2].guard, 'checks the caller');
	const { describeContract, plainName } = await import('../src/chain/graph');
	assert.equal(plainName('transferOwnership'), 'transfer ownership');
	assert.equal(describeContract(v), 'It takes LCAI in and can pay it out. Anyone can deposit and withdraw. Only the owner or an allowed caller can sweep.');
	assert.equal(describeContract(map[0]), 'A building block other contracts build on. Only the owner or an allowed caller can set owner.');
	assert.match(describeContract(map[1]), /promises to have/);
});

test('app preview: one HTML file with the contract\'s values and functions, and a script that compiles', async () => {
	const { generateApp, words } = await import('../src/chain/appTemplate');
	const vm = await import('node:vm');
	assert.equal(words('feeBps'), 'Fee bps');
	assert.equal(words('set_fee'), 'Set fee');
	const html = generateApp({ name: 'Vault', address: '0x52a1c0ffee52a1c0ffee52a1c0ffee52a1c09f3c', abi: vault.abi, network: { label: 'Testnet', chainId: 8200, rpcUrl: 'https://rpc.testnet.lightchain.ai', explorerUrl: 'https://testnet.lightscan.app' } });
	assert.match(html, /<title>Vault on Lightchain<\/title>/);
	for (const stat of ['owner', 'feeBps', 'total']) {
		assert.ok(html.includes(`data-read="${stat}"`), stat);
	}
	assert.ok(html.includes('data-sig="withdraw(uint256)" data-kind="write"'));
	assert.ok(html.includes('data-sig="deposit()" data-kind="write" data-payable'));
	assert.ok(html.includes('data-sig="balances(address)" data-kind="read"'));
	assert.ok(html.includes('<label>Amount<input name="arg0" data-type="uint256" placeholder="a whole number"'));
	const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)![1];
	assert.match(script, /^\s*import \{[^}]+\} from 'https:\/\/esm\.sh\/viem@2\?bundle';/m);
	assert.doesNotThrow(() => new vm.Script(`(async () => {${script.replace(/^\s*import .*$/m, '')}})`), 'the generated script must parse');
	// a hostile contract name cannot break out of the page
	assert.ok(!generateApp({ name: '</script><script>alert(1)</script>', address: '0x0', abi: [], network: { label: 'T', chainId: 1, rpcUrl: 'r', explorerUrl: 'e' } }).includes('<script>alert(1)'));
	assert.ok(!generateApp({ name: '<img src=x onerror=1>', address: '0x0', abi: [], network: { label: 'T', chainId: 1, rpcUrl: 'r', explorerUrl: 'e' } }).includes('<img src=x'));
});

/**
 * New-project templates. Each is self-contained Solidity (only forge-std for tests and
 * scripts), with tests and a deploy script, and is checked to build and pass `forge test`.
 */
export interface Template { id: string; label: string; detail: string; files: Record<string, string> }

const SPDX = '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24;\n';

const deployScript = (contract: string, args = '') => `${SPDX}
import {Script} from "forge-std/Script.sol";
import {${contract}} from "../src/${contract}.sol";

contract Deploy is Script {
    function run() external returns (${contract} deployed) {
        vm.startBroadcast();
        deployed = new ${contract}(${args});
        vm.stopBroadcast();
    }
}
`;

const counter: Template = {
	id: 'counter', label: 'Starter', detail: 'A minimal counter contract — the quickest way to try build, test and deploy',
	files: {
		'src/Counter.sol': `${SPDX}
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
		'test/Counter.t.sol': `${SPDX}
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

    function testFuzz_SetNumber(uint256 x) public {
        counter.setNumber(x);
        assertEq(counter.number(), x);
    }
}
`,
		'script/Deploy.s.sol': deployScript('Counter'),
	},
};

const token: Template = {
	id: 'token', label: 'ERC-20 token', detail: 'A standard fungible token; the deployer receives the initial supply',
	files: {
		'src/Token.sol': `${SPDX}
/// @notice Minimal ERC-20: fixed supply minted to the deployer.
contract Token {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint256 initialSupply) {
        name = name_;
        symbol = symbol_;
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "zero address");
        require(balanceOf[from] >= value, "balance");
        unchecked {
            balanceOf[from] -= value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
`,
		'test/Token.t.sol': `${SPDX}
import {Test} from "forge-std/Test.sol";
import {Token} from "../src/Token.sol";

contract TokenTest is Test {
    Token token;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        token = new Token("Lumen", "LUM", 1_000_000 ether);
    }

    function test_InitialSupplyToDeployer() public view {
        assertEq(token.totalSupply(), 1_000_000 ether);
        assertEq(token.balanceOf(address(this)), 1_000_000 ether);
    }

    function test_Transfer() public {
        token.transfer(alice, 100 ether);
        assertEq(token.balanceOf(alice), 100 ether);
    }

    function test_TransferFromUsesAllowance() public {
        token.approve(alice, 50 ether);
        vm.prank(alice);
        token.transferFrom(address(this), bob, 30 ether);
        assertEq(token.balanceOf(bob), 30 ether);
        assertEq(token.allowance(address(this), alice), 20 ether);
    }

    function test_RevertWhen_BalanceTooLow() public {
        vm.prank(alice);
        vm.expectRevert(bytes("balance"));
        token.transfer(bob, 1);
    }
}
`,
		'script/Deploy.s.sol': deployScript('Token', '"Lumen", "LUM", 1_000_000 ether'),
	},
};

const nft: Template = {
	id: 'nft', label: 'NFT collection (ERC-721)', detail: 'An ERC-721 collection the owner can mint, with a base URI for metadata',
	files: {
		'src/Collection.sol': `${SPDX}
interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4);
}

/// @notice Minimal ERC-721: the owner mints; metadata at baseURI + tokenId.
contract Collection {
    string public name;
    string public symbol;
    string public baseURI;
    address public owner;
    uint256 public totalSupply;

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(string memory name_, string memory symbol_, string memory baseURI_) {
        name = name_;
        symbol = symbol_;
        baseURI = baseURI_;
        owner = msg.sender;
    }

    function mint(address to) external returns (uint256 tokenId) {
        require(msg.sender == owner, "not owner");
        require(to != address(0), "zero address");
        tokenId = ++totalSupply;
        ownerOf[tokenId] = to;
        balanceOf[to]++;
        emit Transfer(address(0), to, tokenId);
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(ownerOf[tokenId] != address(0), "no token");
        return string.concat(baseURI, _toString(tokenId));
    }

    function approve(address to, uint256 tokenId) external {
        address holder = ownerOf[tokenId];
        require(msg.sender == holder || isApprovedForAll[holder][msg.sender], "not allowed");
        getApproved[tokenId] = to;
        emit Approval(holder, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(ownerOf[tokenId] == from, "wrong from");
        require(to != address(0), "zero address");
        require(msg.sender == from || getApproved[tokenId] == msg.sender || isApprovedForAll[from][msg.sender], "not allowed");
        balanceOf[from]--;
        balanceOf[to]++;
        ownerOf[tokenId] = to;
        delete getApproved[tokenId];
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            require(IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) == IERC721Receiver.onERC721Received.selector, "unsafe recipient");
        }
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f; // ERC165, ERC721, ERC721Metadata
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory b = new bytes(len);
        for (; v != 0; v /= 10) b[--len] = bytes1(uint8(48 + v % 10));
        return string(b);
    }
}
`,
		'test/Collection.t.sol': `${SPDX}
import {Test} from "forge-std/Test.sol";
import {Collection} from "../src/Collection.sol";

contract CollectionTest is Test {
    Collection nft;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        nft = new Collection("Lightchain Art", "LART", "ipfs://collection/");
    }

    function test_OwnerMints() public {
        uint256 id = nft.mint(alice);
        assertEq(nft.ownerOf(id), alice);
        assertEq(nft.balanceOf(alice), 1);
        assertEq(nft.tokenURI(id), "ipfs://collection/1");
    }

    function test_RevertWhen_NotOwnerMints() public {
        vm.prank(alice);
        vm.expectRevert(bytes("not owner"));
        nft.mint(alice);
    }

    function test_TransferByHolder() public {
        uint256 id = nft.mint(alice);
        vm.prank(alice);
        nft.transferFrom(alice, bob, id);
        assertEq(nft.ownerOf(id), bob);
    }
}
`,
		'script/Deploy.s.sol': deployScript('Collection', '"Lightchain Art", "LART", "ipfs://collection/"'),
	},
};

const coinFlip: Template = {
	id: 'coinflip', label: 'Two-player coin flip', detail: 'A fair 50/50 game between two players with no house cut (commit–reveal)',
	files: {
		'src/CoinFlip.sol': `${SPDX}
/// @notice Two players stake the same amount; a fair coin decides; the winner takes the pot. No house cut.
/// @dev Commit–reveal: the creator commits to a secret, the joiner picks heads/tails, then the creator
///      reveals. If the creator does not reveal before the deadline, the joiner wins by default, so
///      refusing to reveal never helps the creator.
contract CoinFlip {
    struct Game {
        address creator;
        address joiner;
        uint256 stake;
        bytes32 commitment;  // keccak256(abi.encodePacked(secret, creator))
        bool joinerGuess;     // true = heads
        uint64 revealDeadline;
        bool settled;
    }

    uint64 public constant REVEAL_WINDOW = 1 hours;
    uint256 public gameCount;
    mapping(uint256 => Game) public games;

    event Created(uint256 indexed id, address indexed creator, uint256 stake);
    event Joined(uint256 indexed id, address indexed joiner, bool guess);
    event Settled(uint256 indexed id, address indexed winner, uint256 pot, bool heads);
    event Cancelled(uint256 indexed id);

    function create(bytes32 commitment) external payable returns (uint256 id) {
        require(msg.value > 0, "stake");
        id = ++gameCount;
        games[id] = Game(msg.sender, address(0), msg.value, commitment, false, 0, false);
        emit Created(id, msg.sender, msg.value);
    }

    function join(uint256 id, bool guessHeads) external payable {
        Game storage g = games[id];
        require(g.creator != address(0) && !g.settled, "no game");
        require(g.joiner == address(0), "full");
        require(msg.sender != g.creator, "own game");
        require(msg.value == g.stake, "stake mismatch");
        g.joiner = msg.sender;
        g.joinerGuess = guessHeads;
        g.revealDeadline = uint64(block.timestamp) + REVEAL_WINDOW;
        emit Joined(id, msg.sender, guessHeads);
    }

    function reveal(uint256 id, bytes32 secret) external {
        Game storage g = games[id];
        require(g.joiner != address(0) && !g.settled, "not ready");
        require(keccak256(abi.encodePacked(secret, g.creator)) == g.commitment, "bad secret");
        // the coin mixes the creator's secret with the joiner's address: neither side controls it alone
        bool heads = uint256(keccak256(abi.encodePacked(secret, g.joiner))) % 2 == 0;
        _settle(id, heads == g.joinerGuess ? g.joiner : g.creator, heads);
    }

    function claimTimeout(uint256 id) external {
        Game storage g = games[id];
        require(g.joiner != address(0) && !g.settled, "not ready");
        require(block.timestamp > g.revealDeadline, "too early");
        _settle(id, g.joiner, g.joinerGuess);
    }

    function cancel(uint256 id) external {
        Game storage g = games[id];
        require(msg.sender == g.creator && g.joiner == address(0) && !g.settled, "cannot cancel");
        g.settled = true;
        emit Cancelled(id);
        _pay(g.creator, g.stake);
    }

    function _settle(uint256 id, address winner, bool heads) internal {
        Game storage g = games[id];
        g.settled = true;
        uint256 pot = g.stake * 2;
        emit Settled(id, winner, pot, heads);
        _pay(winner, pot);
    }

    function _pay(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "payout failed");
    }
}
`,
		'test/CoinFlip.t.sol': `${SPDX}
import {Test} from "forge-std/Test.sol";
import {CoinFlip} from "../src/CoinFlip.sol";

contract CoinFlipTest is Test {
    CoinFlip game;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    bytes32 secret = keccak256("alice's secret");

    function setUp() public {
        game = new CoinFlip();
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    function _play(bool bobGuess) internal returns (uint256 id) {
        vm.prank(alice);
        id = game.create{value: 1 ether}(keccak256(abi.encodePacked(secret, alice)));
        vm.prank(bob);
        game.join{value: 1 ether}(id, bobGuess);
    }

    function test_WinnerTakesWholePot() public {
        bool heads = uint256(keccak256(abi.encodePacked(secret, bob))) % 2 == 0;
        uint256 id = _play(heads); // bob guesses right
        vm.prank(alice);
        game.reveal(id, secret);
        assertEq(bob.balance, 11 ether);
        assertEq(alice.balance, 9 ether);
        assertEq(address(game).balance, 0);
    }

    function test_CreatorWinsOnWrongGuess() public {
        bool heads = uint256(keccak256(abi.encodePacked(secret, bob))) % 2 == 0;
        uint256 id = _play(!heads);
        game.reveal(id, secret); // anyone may reveal once the secret is known
        assertEq(alice.balance, 11 ether);
    }

    function test_JoinerWinsIfCreatorDoesNotReveal() public {
        uint256 id = _play(true);
        vm.warp(block.timestamp + 1 hours + 1);
        game.claimTimeout(id);
        assertEq(bob.balance, 11 ether);
    }

    function test_RevertWhen_WrongSecret() public {
        uint256 id = _play(true);
        vm.expectRevert(bytes("bad secret"));
        game.reveal(id, keccak256("guess"));
    }

    function test_CreatorCanCancelBeforeJoin() public {
        vm.prank(alice);
        uint256 id = game.create{value: 1 ether}(keccak256(abi.encodePacked(secret, alice)));
        vm.prank(alice);
        game.cancel(id);
        assertEq(alice.balance, 10 ether);
    }
}
`,
		'script/Deploy.s.sol': deployScript('CoinFlip'),
	},
};

const escrow: Template = {
	id: 'escrow', label: 'Escrow', detail: 'A buyer funds a payment that an arbiter releases to the seller or refunds',
	files: {
		'src/Escrow.sol': `${SPDX}
/// @notice One payment held in escrow: the buyer funds it, the arbiter (or the buyer) releases it to
///         the seller, or the arbiter (or the seller) refunds it to the buyer.
contract Escrow {
    address public immutable buyer;
    address public immutable seller;
    address public immutable arbiter;
    enum State { AwaitingPayment, Funded, Released, Refunded }
    State public state;

    event Funded(uint256 amount);
    event Released(uint256 amount);
    event Refunded(uint256 amount);

    constructor(address seller_, address arbiter_) {
        buyer = msg.sender;
        seller = seller_;
        arbiter = arbiter_;
    }

    function fund() external payable {
        require(msg.sender == buyer, "only buyer");
        require(state == State.AwaitingPayment && msg.value > 0, "cannot fund");
        state = State.Funded;
        emit Funded(msg.value);
    }

    function release() external {
        require(msg.sender == buyer || msg.sender == arbiter, "not allowed");
        require(state == State.Funded, "not funded");
        state = State.Released;
        uint256 amount = address(this).balance;
        emit Released(amount);
        _pay(seller, amount);
    }

    function refund() external {
        require(msg.sender == seller || msg.sender == arbiter, "not allowed");
        require(state == State.Funded, "not funded");
        state = State.Refunded;
        uint256 amount = address(this).balance;
        emit Refunded(amount);
        _pay(buyer, amount);
    }

    function _pay(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "payment failed");
    }
}
`,
		'test/Escrow.t.sol': `${SPDX}
import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";

contract EscrowTest is Test {
    Escrow escrow;
    address seller = address(0x5E11);
    address arbiter = address(0xA4B);

    function setUp() public {
        escrow = new Escrow(seller, arbiter);
        escrow.fund{value: 2 ether}();
    }

    function test_ArbiterReleasesToSeller() public {
        vm.prank(arbiter);
        escrow.release();
        assertEq(seller.balance, 2 ether);
    }

    function test_SellerRefundsBuyer() public {
        uint256 before = address(this).balance;
        vm.prank(seller);
        escrow.refund();
        assertEq(address(this).balance, before + 2 ether);
    }

    function test_RevertWhen_StrangerReleases() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(bytes("not allowed"));
        escrow.release();
    }

    receive() external payable {}
}
`,
		'script/Deploy.s.sol': deployScript('Escrow', 'msg.sender, msg.sender /* replace with the seller and arbiter addresses */'),
	},
};

export const TEMPLATES: Template[] = [counter, token, nft, coinFlip, escrow];

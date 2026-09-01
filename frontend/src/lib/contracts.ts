import { encodeAbiParameters, encodePacked, keccak256, parseAbi } from "viem";

export const SEPOLIA_CHAIN_ID = 11155111;

export const HAZE_HOOK_ADDRESS = "0x47eba0b231d3cec1d74597ddab60df6a41048080" as const;
export const TEST_TOKEN_ADDRESS = "0xde8a1613ee95a0ee72ff5b72af2aadfe6c783f3d" as const;
export const WETH_ADDRESS = "0xfff9976782d46cc05630d1f6ebab18b2324d6b14" as const;
export const VRF_CONSUMER_ADDRESS = "0x978ac30c2adf302e86b3815a6d165f2893af4ce5" as const;

// Canonical v4 PoolManager on Sepolia (from hookmate's AddressConstants).
export const POOL_MANAGER_ADDRESS = "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543" as const;

// currency0 < currency1 by address. Points at the fee-500 pool from
// DeployLopsidedPool.s.sol (1 WETH = 10,000 HTT) rather than the original
// fee-3000 pool DeployPool.s.sol created (~1:1, only ~1.4 HTT total reserve)
// — the lopsided pool has real depth relative to normal test swap sizes.
// The original pool is untouched and still exists on-chain, just unused here.
export const POOL_KEY = {
  currency0: TEST_TOKEN_ADDRESS,
  currency1: WETH_ADDRESS,
  fee: 500,
  tickSpacing: 10,
  hooks: HAZE_HOOK_ADDRESS,
} as const;

const POOL_KEY_TUPLE = "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)";

export const HAZE_HOOK_ABI = parseAbi([
  `function RISK_THRESHOLD_BPS() view returns (uint256)`,
  `function PRICE_BAND_BPS() view returns (uint256)`,
  `function estimatedImpactBps(${POOL_KEY_TUPLE} key, bool zeroForOne, int256 amountSpecified) view returns (uint256)`,
  `function isProtected(${POOL_KEY_TUPLE} key, bool zeroForOne, int256 amountSpecified) view returns (bool)`,
  `function recommendedSlippageBps(${POOL_KEY_TUPLE} key, bool zeroForOne, int256 amountSpecified) view returns (uint256)`,
  `function commitSwap(${POOL_KEY_TUPLE} key, bool zeroForOne, int256 amountSpecified, uint256 deadline) returns (uint256 swapId)`,
  `function settleSwap(uint256 swapId) returns (uint160 sqrtPriceLimitX96)`,
  `function cancelExpiredSwap(uint256 swapId)`,
  `event SwapCommitted(address indexed trader, uint256 indexed swapId, uint256 indexed requestId)`,
  `event SwapSettled(uint256 indexed swapId, uint8 candidateIndex, uint160 sqrtPriceLimitX96)`,
  `event SwapCancelled(uint256 indexed swapId, address indexed trader)`,
]);

const ERC20_FUNCTIONS = [
  `function balanceOf(address) view returns (uint256)`,
  `function decimals() view returns (uint8)`,
  `function symbol() view returns (string)`,
  `function allowance(address owner, address spender) view returns (uint256)`,
  `function approve(address spender, uint256 amount) returns (bool)`,
];

export const ERC20_ABI = parseAbi(ERC20_FUNCTIONS);

// HTT is a MockERC20 with a deliberately open mint() — no access control, so
// anyone can mint themselves test tokens directly.
export const MOCK_TOKEN_ABI = parseAbi([...ERC20_FUNCTIONS, `function mint(address to, uint256 amount)`]);

// Real Sepolia WETH — no mint, just wraps ETH you send it via deposit().
export const WETH9_ABI = parseAbi([...ERC20_FUNCTIONS, `function deposit() payable`]);

export const VRF_CONSUMER_ABI = parseAbi([
  `function resultForSwap(uint256 swapId) view returns (bool fulfilled, uint8 candidateIndex)`,
]);

// Sepolia's canonical V4Quoter. Simulates a real swap through the pool to get
// an exact quote — which means it goes through HazeHook's _beforeSwap too, so
// it only returns a value for fast-lane amounts. Protected-lane amounts make
// it revert (ProtectedSwapRequired), same as a real swap would — there's no
// exact quote possible there since the settlement price is only decided by
// VRF after commit.
export const V4_QUOTER_ADDRESS = "0x61b3f2011a92d183c7dbadbda940a7555ccf9227" as const;

export const V4_QUOTER_ABI = parseAbi([
  `function quoteExactInputSingle((${POOL_KEY_TUPLE} poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)`,
]);

// Sepolia's canonical V4 swap router — handles real fast-lane execution.
// Protected-lane amounts still go through HazeHook's own commitSwap/settleSwap
// (this router would just hit the same _beforeSwap revert a plain swap would).
export const V4_ROUTER_ADDRESS = "0xf13D190e9117920c703d79B5F33732e10049b115" as const;

export const V4_ROUTER_ABI = parseAbi([
  // BalanceDelta is a Solidity user-defined value type wrapping a single
  // int256 (amount0/amount1 packed into the high/low 128 bits) — one return
  // value at the ABI level, not two.
  `function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, bool zeroForOne, ${POOL_KEY_TUPLE} poolKey, bytes hookData, address receiver, uint256 deadline) payable returns (int256 delta)`,
]);

// Reads the pool's live sqrtPriceX96 straight out of PoolManager storage via
// extsload — the same technique StateLibrary.getSlot0 uses on-chain. There's
// no exposed view function for "current price" on the hook itself, and this
// avoids needing a separate StateView periphery deployment.
export const EXTSLOAD_ABI = parseAbi([`function extsload(bytes32 slot) view returns (bytes32)`]);

const POOLS_MAPPING_SLOT = BigInt(6); // PoolManager's `pools` mapping is storage slot 6.

export function poolStateSlot(): `0x${string}` {
  const poolId = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [POOL_KEY.currency0, POOL_KEY.currency1, POOL_KEY.fee, POOL_KEY.tickSpacing, POOL_KEY.hooks],
    ),
  );
  return keccak256(encodePacked(["bytes32", "uint256"], [poolId, POOLS_MAPPING_SLOT]));
}

// Slot0 packs sqrtPriceX96 in the low 160 bits (see StateLibrary.getSlot0).
export function sqrtPriceX96FromSlot0(slot0: `0x${string}`): bigint {
  const mask = (BigInt(1) << BigInt(160)) - BigInt(1);
  return BigInt(slot0) & mask;
}

// Mirrors the constants in src/HazeHook.sol — kept here as plain numbers for
// display copy rather than reading them on every page load, since they're
// immutable in the deployed contract.
export const HOOK_PARAMS = {
  riskThresholdBps: 50,
  priceBandBps: 20,
  numCandidates: 5,
  premiumBps: 10,
} as const;

const SEPOLIA_EXPLORER = "https://sepolia.etherscan.io";

export const explorerAddressLink = (address: string) => `${SEPOLIA_EXPLORER}/address/${address}`;
export const explorerTxLink = (hash: string) => `${SEPOLIA_EXPLORER}/tx/${hash}`;

export const CONTRACT_LINKS = [
  { label: "HazeHook", address: HAZE_HOOK_ADDRESS },
  { label: "VRFConsumer", address: VRF_CONSUMER_ADDRESS },
  { label: "Test token", address: TEST_TOKEN_ADDRESS },
  { label: "WETH", address: WETH_ADDRESS },
].map((c) => ({ ...c, href: explorerAddressLink(c.address) }));

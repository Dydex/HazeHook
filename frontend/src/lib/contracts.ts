import { parseAbi } from "viem";

export const SEPOLIA_CHAIN_ID = 11155111;

export const HAZE_HOOK_ADDRESS = "0x47eba0b231d3cec1d74597ddab60df6a41048080" as const;
export const TEST_TOKEN_ADDRESS = "0xde8a1613ee95a0ee72ff5b72af2aadfe6c783f3d" as const;
export const WETH_ADDRESS = "0xfff9976782d46cc05630d1f6ebab18b2324d6b14" as const;

// currency0 < currency1 by address, matching how DeployPool.s.sol built the PoolKey.
export const POOL_KEY = {
  currency0: TEST_TOKEN_ADDRESS,
  currency1: WETH_ADDRESS,
  fee: 3000,
  tickSpacing: 60,
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

export const ERC20_ABI = parseAbi([
  `function balanceOf(address) view returns (uint256)`,
  `function decimals() view returns (uint8)`,
  `function symbol() view returns (string)`,
  `function allowance(address owner, address spender) view returns (uint256)`,
  `function approve(address spender, uint256 amount) returns (bool)`,
]);

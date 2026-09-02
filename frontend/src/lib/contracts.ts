import { encodeAbiParameters, encodePacked, keccak256, parseAbi } from "viem";

export const SEPOLIA_CHAIN_ID = 11155111;

// Redeployed hook — carries the commit-bond fix (closes a free VRF-spam
// griefing vector) and the exact-output classification fix (previously a
// documented bypass). The prior hook at 0x47eba0b2...048080 is retired; its
// pool is left untouched but no longer used by this frontend.
export const HAZE_HOOK_ADDRESS = "0x693a5f83f6a88bd455828fa1e99039edfcaf0080" as const;
export const TEST_TOKEN_ADDRESS = "0xde8a1613ee95a0ee72ff5b72af2aadfe6c783f3d" as const;
export const WETH_ADDRESS = "0xfff9976782d46cc05630d1f6ebab18b2324d6b14" as const;
// Unchanged — this is the same VRFConsumer as before, just repointed at the
// new hook via setHook() rather than redeployed.
export const VRF_CONSUMER_ADDRESS = "0x978ac30c2adf302e86b3815a6d165f2893af4ce5" as const;
// commitSwap() now requires this exact native-token bond per commit,
// refundable via withdrawBond() once the swap settles or is cancelled.
export const COMMIT_BOND_WEI = BigInt("1000000000000000"); // 0.001 ETH

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
  `function COMMIT_BOND() view returns (uint256)`,
  `function unclaimedBond(address) view returns (uint256)`,
  `function estimatedImpactBps(${POOL_KEY_TUPLE} key, bool zeroForOne, int256 amountSpecified) view returns (uint256)`,
  `function isProtected(${POOL_KEY_TUPLE} key, bool zeroForOne, int256 amountSpecified) view returns (bool)`,
  `function recommendedSlippageBps(${POOL_KEY_TUPLE} key, bool zeroForOne, int256 amountSpecified) view returns (uint256)`,
  `function commitSwap(${POOL_KEY_TUPLE} key, bool zeroForOne, int256 amountSpecified, uint256 deadline) payable returns (uint256 swapId)`,
  `function settleSwap(uint256 swapId) returns (uint160 sqrtPriceLimitX96)`,
  `function cancelExpiredSwap(uint256 swapId)`,
  `function withdrawBond()`,
  `event SwapCommitted(address indexed trader, uint256 indexed swapId, uint256 indexed requestId)`,
  `event SwapSettled(uint256 indexed swapId, uint8 candidateIndex, uint160 sqrtPriceLimitX96)`,
  `event SwapCancelled(uint256 indexed swapId, address indexed trader)`,
  `event PremiumRecaptured(uint256 indexed swapId, bool isCurrency0, uint256 amount)`,
  `event BondWithdrawn(address indexed trader, uint256 amount)`,
]);

// The block the currently-live HazeHook was deployed/repointed at — used to
// scope PremiumRecaptured event scans instead of querying from genesis.
export const HAZE_HOOK_DEPLOY_BLOCK = BigInt(11617932);

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

// Slot0 packs tick as a signed 24-bit value in the next 24 bits after
// sqrtPriceX96 (see StateLibrary.getSlot0).
export function tickFromSlot0(slot0: `0x${string}`): number {
  const shifted = BigInt(slot0) >> BigInt(160);
  const raw = shifted & ((BigInt(1) << BigInt(24)) - BigInt(1));
  const signBit = BigInt(1) << BigInt(23);
  const tick = raw & signBit ? raw - (BigInt(1) << BigInt(24)) : raw;
  return Number(tick);
}

// Pool.State's `liquidity` field sits 3 slots after the state slot (see
// StateLibrary.getLiquidity's LIQUIDITY_OFFSET).
export function poolLiquiditySlot(): `0x${string}` {
  const offset = BigInt(3);
  const asHex = (BigInt(poolStateSlot()) + offset).toString(16).padStart(64, "0");
  return `0x${asHex}`;
}

// Approximates the amount needed to move the pool by targetImpactBps, using
// the same SqrtPriceMath relationship HazeHook.estimatedImpactBps is built
// on (validated against the deployed contract's real output). The two swap
// directions have different shapes: token0 (HTT) in saturates as amount
// grows, token1 (WETH) in is linear — see HazeHook.sol's estimatedImpactBps
// for the on-chain version this mirrors.
export function amountForTargetImpact(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  targetImpactBps: number,
  zeroForOne: boolean,
): number {
  const L = Number(liquidity) / 1e18;
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
  const k = targetImpactBps / 20_000;
  if (zeroForOne) {
    // HTT in: amountIn = k*L / (sqrtP*(1-k))
    return (k * L) / (sqrtP * (1 - k));
  }
  // WETH in: amountIn = k*L*sqrtP
  return k * L * sqrtP;
}

// --- Add-liquidity: PositionManager + Permit2 ---
// Canonical addresses on Sepolia (from hookmate's AddressConstants).
export const POSITION_MANAGER_ADDRESS = "0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4" as const;
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

export const POSITION_MANAGER_ABI = parseAbi([
  `function modifyLiquidities(bytes unlockData, uint256 deadline) payable`,
  `function balanceOf(address owner) view returns (uint256)`,
]);

// AllowanceTransfer — Permit2's own allowance system, separate from plain
// ERC20 allowance. PositionManager pulls funds via Permit2, so both an ERC20
// approve(PERMIT2, ...) *and* a Permit2 approve(token, PositionManager, ...)
// are needed before a mint will succeed.
export const PERMIT2_ABI = parseAbi([
  `function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)`,
  `function approve(address token, address spender, uint160 amount, uint48 expiration) external`,
]);

// Subset of PositionManager's Actions.sol constants actually used here.
export const ACTIONS = {
  MINT_POSITION: 0x02,
  SETTLE_PAIR: 0x0d,
  SWEEP: 0x14,
} as const;

// Same wide tick range DeployLopsidedPool.s.sol seeded the pool with
// (±750 * tickSpacing around the pool's starting tick, -92109) — reused here
// so new deposits land in the same position range rather than introducing a
// separate range picker.
export const LP_TICK_LOWER = -99600;
export const LP_TICK_UPPER = -84600;

function sqrtPriceAtTick(tick: number): number {
  return Math.pow(1.0001, tick / 2);
}

// JS port of LiquidityAmounts.getLiquidityForAmounts (Uniswap v3/v4's
// standard concentrated-liquidity formula) — plain floating point, since
// this is only a client-side estimate for the `liquidity` argument. The
// on-chain amount0Max/amount1Max caps are the real safety net: an
// overestimate just reverts, an underestimate just mints a smaller position.
export function estimateLiquidityForAmounts(
  currentTick: number,
  amount0: number,
  amount1: number,
): number {
  const sqrtCurrent = sqrtPriceAtTick(currentTick);
  const sqrtLower = sqrtPriceAtTick(LP_TICK_LOWER);
  const sqrtUpper = sqrtPriceAtTick(LP_TICK_UPPER);

  const liquidityForAmount0 = (a0: number) => (a0 * sqrtLower * sqrtUpper) / (sqrtUpper - sqrtLower);
  const liquidityForAmount1 = (a1: number) => a1 / (sqrtUpper - sqrtLower);

  if (sqrtCurrent <= sqrtLower) return liquidityForAmount0(amount0);
  if (sqrtCurrent >= sqrtUpper) return liquidityForAmount1(amount1);
  const l0 = (amount0 * sqrtCurrent * sqrtUpper) / (sqrtUpper - sqrtCurrent);
  const l1 = amount1 / (sqrtCurrent - sqrtLower);
  return Math.min(l0, l1);
}

// Inverse of estimateLiquidityForAmounts — given the pool's actual live
// liquidity and price, returns how much HTT/WETH that liquidity represents
// within the position range (standard Uniswap v3/v4 getAmountsForLiquidity
// formulas). Reading PoolManager's own WETH balance directly isn't usable for
// this: WETH is real, shared Sepolia WETH used by many unrelated pools, so
// its balanceOf reflects everyone's liquidity, not just this pool's. HTT is
// exclusive to this pool, but computing both sides the same way keeps them
// consistent and correctly scoped to this position's range specifically
// (there could in principle be other out-of-range HTT/WETH positions this
// wouldn't capture, though there aren't any today).
export function reservesForLiquidity(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  currentTick: number,
): { htt: number; weth: number } {
  const L = Number(liquidity) / 1e18;
  const sqrtCurrent = Number(sqrtPriceX96) / 2 ** 96;
  const sqrtLower = sqrtPriceAtTick(LP_TICK_LOWER);
  const sqrtUpper = sqrtPriceAtTick(LP_TICK_UPPER);

  if (currentTick <= LP_TICK_LOWER) {
    return { htt: (L * (sqrtUpper - sqrtLower)) / (sqrtLower * sqrtUpper), weth: 0 };
  }
  if (currentTick >= LP_TICK_UPPER) {
    return { htt: 0, weth: L * (sqrtUpper - sqrtLower) };
  }
  return {
    htt: (L * (sqrtUpper - sqrtCurrent)) / (sqrtCurrent * sqrtUpper),
    weth: L * (sqrtCurrent - sqrtLower),
  };
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

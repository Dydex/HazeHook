# Probabilistic Settlement Hook — Full Architecture

**Theme:** UHI10 — Sustainable Liquidity & MEV Protection
**Core mechanism:** Risk-classified swaps settle at a VRF-randomized price within a tight, pre-committed band, defeating precise sandwich-attack timing. Low-risk swaps bypass this entirely and execute instantly.

---

## 1. System Overview

Three components work together:

1. **Risk Classifier** — reads pool state at `beforeSwap` to decide if a swap is "protected-lane" (needs randomized settlement) or "fast-lane" (executes immediately, standard v4 behavior).
2. **Commit/Settle Engine** — for protected-lane swaps, splits execution into two transactions: a commit (locks swap intent + requests randomness) and a settle (executes at the VRF-selected price once randomness is fulfilled).
3. **Recapture + Safe-Slippage Layer** — routes any fee premium from protected-lane swaps to LPs, and exposes a view function frontends can call to recommend safe slippage before a user even submits a swap.

```
User Swap Request
       │
       ▼
 ┌─────────────┐     low impact      ┌──────────────────┐
 │ beforeSwap  │ ──────────────────► │ Standard v4 swap  │
 │ (classify)  │                     │ (fast lane)       │
 └─────────────┘                     └──────────────────┘
       │ high impact
       ▼
 ┌─────────────────┐
 │ Commit swap      │  → request randomness (VRF or prevrandao)
 │ intent + lock     │
 └─────────────────┘
       │  (next block, once randomness fulfilled)
       ▼
 ┌─────────────────┐
 │ Settle swap at    │  → pick 1 of N candidate prices
 │ randomized price  │     within tight band around pool price
 └─────────────────┘
       │
       ▼
 ┌─────────────────┐
 │ Fee routed to LP  │
 │ recapture pool     │
 └─────────────────┘
```

---

## 2. Contracts

### 2.1 `ProtectedSwapHook.sol` (main hook, extends `BaseHook`)

**Permissions needed (`getHookPermissions()`):**
- `beforeSwap: true` — classify risk, redirect protected-lane swaps
- `afterSwap: true` — record swap for volatility/impact tracking, route fees
- `beforeAddLiquidity` / `afterAddLiquidity`: false (unless you later add JIT protection)

**Key state:**

```solidity
// Pending commits awaiting VRF settlement
struct PendingSwap {
    address trader;
    PoolId poolId;
    bool zeroForOne;
    int256 amountSpecified;
    uint256 poolPriceAtCommit;   // sqrtPriceX96 snapshot
    uint256 requestId;           // VRF request id (or block number, if using prevrandao)
    bool settled;
}

mapping(uint256 => PendingSwap) public pendingSwaps; // keyed by requestId
mapping(PoolId => uint256) public recapturePool;      // LP compensation accrual per pool

uint256 public constant RISK_THRESHOLD_BPS = 50;   // 0.5% price impact triggers protected lane
uint256 public constant PRICE_BAND_BPS = 20;        // ±0.2% candidate price spread
uint8   public constant NUM_CANDIDATES = 5;         // number of discrete settlement prices
```

### 2.2 `SwapRandomnessConsumer.sol` (VRF integration)



**A. Chainlink VRF v2.5 (production-grade, async, 2-tx flow — required)**
- `requestRandomWords()` called from the hook's commit step
- `fulfillRandomWords()` callback (from Chainlink's VRF Coordinator) stores the result and marks the pending swap ready to settle
- Requires: VRF subscription funded with LINK/native token on testnet, coordinator address, key hash
---

## 3. Risk Classifier (Price-Impact Based)

Replaces trade-size/whale segmentation — grounded in the research showing thin liquidity + high impact, not raw size, is what makes a trade attractive to sandwich bots.

```solidity
function _classifyRisk(PoolKey calldata key, SwapParams calldata params)
    internal view returns (bool isProtected)
{
    uint128 liquidity = poolManager.getLiquidity(key.toId());
    uint256 priceImpactBps = _estimatePriceImpact(params.amountSpecified, liquidity, key);
    return priceImpactBps > RISK_THRESHOLD_BPS;
}

function _estimatePriceImpact(int256 amountSpecified, uint128 liquidity, PoolKey calldata key)
    internal view returns (uint256 impactBps)
{
    // Approximate impact using current sqrtPriceX96 and liquidity depth.
    // For a v4 pool, impact scales with |amountSpecified| / liquidity.
    // Exact formula depends on tick math — use v4-core's SqrtPriceMath /
    // LiquidityMath helpers rather than reimplementing from scratch.
}
```

**Design note:** `RISK_THRESHOLD_BPS` is your single most important tunable — too low and you push most swaps into the slower, two-transaction protected lane (bad UX); too high and small trades on thin pools (your evidenced highest-risk group) slip through unprotected. Pick a value you can defend with a worked example in your demo (e.g., "a $500 swap on a pool with $50k liquidity crosses this threshold; the same swap on a $2M pool does not").

---

## 4. Commit / Settle Flow

### `beforeSwap` — classify and branch

```solidity
function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
    internal override returns (bytes4, BeforeSwapDelta, uint24)
{
    if (_classifyRisk(key, params)) {
        // Protected lane: block the swap from executing now, commit instead
        uint256 requestId = _requestRandomness(); // VRF or prevrandao stub
        pendingSwaps[requestId] = PendingSwap({
            trader: sender,
            poolId: key.toId(),
            zeroForOne: params.zeroForOne,
            amountSpecified: params.amountSpecified,
            poolPriceAtCommit: _currentSqrtPrice(key),
            requestId: requestId,
            settled: false
        });
        emit SwapCommitted(sender, requestId);
        // Revert or return a zero-delta "no-op" so the raw swap doesn't execute yet —
        // actual v4 mechanics for "pause and resume" need care; see Section 6 caveats.
        revert SwapPendingSettlement(requestId);
    }

    // Fast lane: standard behavior, no override
    return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
}
```

### `fulfillRandomWords` — VRF callback

```solidity
function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
    PendingSwap storage pending = pendingSwaps[requestId];
    uint8 selectedIndex = uint8(randomWords[0] % NUM_CANDIDATES);
    uint256 settlementPrice = _priceFromCandidateIndex(pending.poolPriceAtCommit, selectedIndex);
    _executeSettlement(pending, settlementPrice);
}
```

### `_priceFromCandidateIndex` — the price band

```solidity
function _priceFromCandidateIndex(uint256 basePrice, uint8 index) internal pure returns (uint256) {
    // Spread NUM_CANDIDATES prices evenly across ±PRICE_BAND_BPS around basePrice.
    // e.g. 5 candidates, ±20bps band -> prices at -20, -10, 0, +10, +20 bps from basePrice.
    int256 offsetBps = int256(uint256(index)) * (2 * int256(PRICE_BAND_BPS)) / (NUM_CANDIDATES - 1) - int256(PRICE_BAND_BPS);
    return _applyBpsOffset(basePrice, offsetBps);
}
```

### `_executeSettlement` — actually run the swap

```solidity
function _executeSettlement(PendingSwap storage pending, uint256 settlementPrice) internal {
    // Execute the swap against the pool at (or bounded by) settlementPrice.
    // Collect the fee premium for protected-lane swaps into recapturePool[pending.poolId].
    pending.settled = true;
    emit SwapSettled(pending.trader, settlementPrice);
}
```

---

## 5. Recapture Mechanism

```solidity
uint256 public constant PROTECTED_LANE_FEE_PREMIUM_BPS = 10; // extra fee on protected swaps

function _routeFeesToLPs(PoolId poolId, uint256 premiumAmount) internal {
    // Simplest approach: fold directly into v4's existing fee-growth accounting
    // so it flows to LPs automatically, proportional to liquidity share —
    // avoids building a separate claims/distribution contract.
    recapturePool[poolId] += premiumAmount;
}
```

---

## 6. Safe-Slippage View Function

A read-only helper frontends can call *before* a user submits a swap — directly reflects the research finding that adaptive slippage settings alone prevent most sandwich exposure.

```solidity
function recommendedSlippageBps(PoolKey calldata key, int256 amountSpecified)
    external view returns (uint256 recommendedBps)
{
    uint128 liquidity = poolManager.getLiquidity(key.toId());
    uint256 volatility = _recentVolatility(key.toId()); // rolling price variance
    uint256 impact = _estimatePriceImpact(amountSpecified, liquidity, key);
    // Combine impact + volatility into a single recommended tolerance,
    // tighter than most wallets' naive fixed defaults (0.5%/1%/5%).
    recommendedBps = impact + volatility; // placeholder formula — tune and justify in README
}
```

---

## 7. Important Caveats to Address Head-On (in code comments AND your demo)

1. **Atomicity:** protected-lane swaps are NOT single-transaction. The `beforeSwap` revert-and-commit pattern above is a simplification — in practice you'll likely want swaps to go through a dedicated `commitSwap()` / `settleSwap()` entrypoint on the hook itself (called by the user's router or a relayer), rather than trying to intercept and pause mid-`PoolManager.swap()`. Confirm this against `v4-core`'s actual unlock/settle accounting before finalizing — this is the trickiest engineering piece of the whole project.
2. **VRF latency:** user experience for protected-lane swaps is "submit, wait ~1-2 blocks, then a second transaction (or a keeper-triggered settlement) completes the trade." Be explicit about this in your video — don't imply it's instant.
3. **Price band width is your key defensible parameter.** Too wide → arbitrage leakage (explained earlier). Too narrow → little protection. Have a worked numeric example ready.
4. **`prevrandao` fallback, if used for demo speed, must be labeled as a known-weaker trade-off**, not presented as equivalent to real VRF.

---


## 8. Test Cases to Cover

- Fast-lane swap: low impact → executes immediately, no state left in `pendingSwaps`
- Protected-lane swap: high impact → commit succeeds, settlement blocked until randomness fulfilled
- Settlement price always falls within `±PRICE_BAND_BPS` of the price at commit time
- Fee premium from protected swaps correctly accrues to `recapturePool`
- Classifier threshold behaves correctly at the boundary (impact exactly at `RISK_THRESHOLD_BPS`)
- Randomness produces a roughly uniform distribution across `NUM_CANDIDATES` over many trials

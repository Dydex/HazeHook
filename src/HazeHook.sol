// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager, SwapParams} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {CurrencySettler} from "@openzeppelin/uniswap-hooks/src/utils/CurrencySettler.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";

interface ISwapRandomnessConsumer {
    function requestRandomness(uint256 swapId) external returns (uint256 requestId);
    function resultForSwap(uint256 swapId) external view returns (bool fulfilled, uint8 candidateIndex);
}

/// @title ProtectedSwapHook ("Haze")
/// @notice Routes high-price-impact swaps through a commit/settle flow where the
///         swap's ALLOWED SLIPPAGE BOUND (sqrtPriceLimitX96) is selected from one
///         of NUM_CANDIDATES pre-committed values via external randomness, rather
///         than being fixed at commit time. This prevents an attacker from knowing
///         in advance how much slippage room a swap will tolerate before it partial-
///         fills or reverts, which weakens precise sandwich-attack sizing.
/// @dev IMPORTANT (documented honestly, not glossed over): this does NOT force the
///      swap to execute at a randomly chosen price. sqrtPriceLimitX96 is a bound,
///      not a target — given fixed liquidity and amountSpecified, the execution
///      price itself is close to deterministic. The randomness varies the fill
///      boundary an attacker must plan around, not the settlement price itself.
///      A future version could achieve true price-targeting by deriving
///      amountSpecified from the chosen candidate price via SqrtPriceMath.
contract HazeHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    error NotTrader();
    error AlreadySettled();
    error RandomnessNotReady();
    error SwapExpired();
    error InvalidDeadline();
    error ExactInputOnly();
    error CannotCancelBeforeExpiry();
    error ProtectedSwapRequired(uint256 impactBps);
    error PoolNotInitialized();
    error BelowRiskThreshold(uint256 impactBps);
    error IncorrectBondAmount(uint256 expected, uint256 provided);
    error NoBondToWithdraw();
    error BondTransferFailed();

    uint256 public constant RISK_THRESHOLD_BPS = 50;
    uint256 public constant PRICE_BAND_BPS = 20;
    uint8 public constant NUM_CANDIDATES = 5;
    uint256 public constant PROTECTED_LANE_FEE_PREMIUM_BPS = 10;

    /// @notice Native-token bond required to commitSwap(), refundable via
    ///         withdrawBond() once the swap is settled or cancelled.
    /// @dev Closes a real griefing vector: estimatedImpactBps is computed from
    ///      `amountSpecified` as a bare number — commitSwap never checked that
    ///      the caller actually holds or approved that amount. Without a cost
    ///      attached to the call itself, anyone could pass an arbitrarily large
    ///      amountSpecified to trivially clear RISK_THRESHOLD_BPS against any
    ///      real pool and force a paid VRF request for the price of gas alone,
    ///      repeatable in a loop to drain the VRF subscription's LINK balance.
    ///      A fixed bond makes every request cost real, locked capital (fully
    ///      refundable, but only after settling or cancelling), which scales
    ///      an attacker's cost with the number of requests they force.
    uint256 public constant COMMIT_BOND = 0.001 ether;

    struct PendingSwap {
        address trader;
        PoolId poolId;
        PoolKey key;
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceAtCommit;
        uint256 requestId;
        uint256 deadline;
        bool settled;
    }

    ISwapRandomnessConsumer public immutable randomnessConsumer;
    uint256 public nextSwapId = 1;
    mapping(uint256 => PendingSwap) public pendingSwaps;
    mapping(address => uint256) public unclaimedBond;
    bool private settling;

    event SwapCommitted(address indexed trader, uint256 indexed swapId, uint256 indexed requestId);
    event SwapSettled(uint256 indexed swapId, uint8 candidateIndex, uint160 sqrtPriceLimitX96);
    event SwapCancelled(uint256 indexed swapId, address indexed trader);
    event PremiumRecaptured(uint256 indexed swapId, bool isCurrency0, uint256 amount);
    event BondWithdrawn(address indexed trader, uint256 amount);

    constructor(IPoolManager manager, ISwapRandomnessConsumer consumer)
        BaseHook(manager)
    {
        randomnessConsumer = consumer;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false,
            beforeDonate: false,
            afterDonate: false
        });
    }

    /// @dev Blocks high-impact swaps from going through the normal v4 swap path,
    ///      forcing them through commitSwap/settleSwap instead. The `settling`
    ///      flag lets the hook's OWN internal settlement swap (triggered from
    ///      unlockCallback) pass through without re-triggering this check on
    ///      itself.
    ///      FIX: previously only exact-input swaps (amountSpecified < 0) were
    ///      classified here, so a trader could bypass protection entirely by
    ///      submitting the same trade as exact-output. estimatedImpactBps
    ///      already takes the magnitude of amountSpecified regardless of sign,
    ///      so it works unchanged for both — this now classifies every swap.
    ///      Since commitSwap is exact-input only (see its own @dev comment),
    ///      a high-impact exact-output swap has no protected route through
    ///      this pool at all; it simply reverts, and the trader has to resubmit
    ///      as exact-input to use the commit/settle flow.
    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (!settling && params.amountSpecified != 0) {
            uint256 impactBps = estimatedImpactBps(key, params.zeroForOne, params.amountSpecified);
            if (impactBps > RISK_THRESHOLD_BPS) {
                revert ProtectedSwapRequired(impactBps);
            }
        }
        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /// @notice Step 1 of the protected flow. Records the swap intent, snapshots
    ///         the live pool price, and requests randomness for later settlement.
    /// @dev Token custody: the trader must have approved this hook contract (or
    ///      the appropriate Permit2 allowance, depending on your CurrencySettler
    ///      configuration) for the input token BEFORE calling commitSwap, since
    ///      unlockCallback will attempt to pull funds from `trader` at settlement
    ///      time. This prototype does not yet enforce or check that allowance
    ///      up front — settleSwap will simply revert at the transfer step if it's
    ///      missing. Flag this clearly as a known gap in your README.
    /// @dev Gated to exact-input swaps that actually clear RISK_THRESHOLD_BPS,
    ///      AND requires COMMIT_BOND of native currency as msg.value. The impact
    ///      gate alone is not a real cost: estimatedImpactBps is computed from
    ///      amountSpecified as a bare number, with no balance/allowance check,
    ///      so anyone could pass an arbitrarily large amountSpecified to clear
    ///      the threshold for free and force a paid VRF request — repeatable in
    ///      a loop to drain the subscription's LINK. The bond is refundable via
    ///      withdrawBond() once the swap is settled or cancelled, but must be
    ///      posted and locked for every individual request, which is what
    ///      actually scales an attacker's cost with request volume.
    function commitSwap(
        PoolKey calldata key,
        bool zeroForOne,
        int256 amountSpecified,
        uint256 deadline
    ) external payable returns (uint256 swapId) {
        if (msg.value != COMMIT_BOND) revert IncorrectBondAmount(COMMIT_BOND, msg.value);
        if (deadline <= block.timestamp) revert InvalidDeadline();
        if (amountSpecified >= 0) revert ExactInputOnly();

        // Check pool initialization BEFORE estimating impact: estimatedImpactBps
        // itself returns 0bps for an uninitialized pool (sqrtPriceX96 == 0), which
        // is always <= RISK_THRESHOLD_BPS. Checking impact first meant an
        // uninitialized pool always reverted with the misleading
        // BelowRiskThreshold(0) instead of PoolNotInitialized, making the latter
        // dead code.
        (uint160 sqrtPriceAtCommit,,,) = poolManager.getSlot0(key.toId());
        if (sqrtPriceAtCommit == 0) revert PoolNotInitialized();

        uint256 impactBps = estimatedImpactBps(key, zeroForOne, amountSpecified);
        if (impactBps <= RISK_THRESHOLD_BPS) revert BelowRiskThreshold(impactBps);

        swapId = nextSwapId++;
        uint256 requestId = randomnessConsumer.requestRandomness(swapId);
        pendingSwaps[swapId] = PendingSwap({
            trader: msg.sender,
            poolId: key.toId(),
            key: key,
            zeroForOne: zeroForOne,
            amountSpecified: amountSpecified,
            sqrtPriceAtCommit: sqrtPriceAtCommit,
            requestId: requestId,
            deadline: deadline,
            settled: false
        });

        emit SwapCommitted(msg.sender, swapId, requestId);
    }

    /// @notice Returns the estimated price impact of a single-tick swap, in basis
    ///         points, using the same sqrt-price math the pool itself swaps with.
    /// @dev Uses SqrtPriceMath.getNextSqrtPriceFromInput to find the sqrt price
    ///      after trading `amountSpecified` against the pool's CURRENT liquidity,
    ///      then converts the sqrt-price move to a price move via the first-order
    ///      approximation d(price)/price ~= 2 * d(sqrtPrice)/sqrtPrice (price is
    ///      sqrtPrice^2, so this is accurate for the sub-few-percent impacts this
    ///      hook classifies on). Ignores tick-crossing beyond the current tick's
    ///      liquidity, same as the real swap would for a trade that stays within
    ///      it — for larger trades this under-estimates impact, which is the safe
    ///      direction for a risk classifier (worst case: routes something to the
    ///      protected lane that a full simulation would've called fast-lane, not
    ///      the reverse).
    function estimatedImpactBps(PoolKey calldata key, bool zeroForOne, int256 amountSpecified)
        public
        view
        returns (uint256 impactBps)
    {
        if (amountSpecified == 0) return 0;

        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        uint128 liquidity = poolManager.getLiquidity(key.toId());
        if (sqrtPriceX96 == 0 || liquidity == 0) return 0;

        uint256 amountIn = uint256(amountSpecified < 0 ? -amountSpecified : amountSpecified);
        uint160 sqrtPriceNextX96 =
            SqrtPriceMath.getNextSqrtPriceFromInput(sqrtPriceX96, liquidity, amountIn, zeroForOne);

        uint256 sqrtPriceDelta = sqrtPriceX96 > sqrtPriceNextX96
            ? sqrtPriceX96 - sqrtPriceNextX96
            : sqrtPriceNextX96 - sqrtPriceX96;

        impactBps = (sqrtPriceDelta * 20_000) / uint256(sqrtPriceX96);
    }

    function isProtected(PoolKey calldata key, bool zeroForOne, int256 amountSpecified)
        public
        view
        returns (bool)
    {
        return estimatedImpactBps(key, zeroForOne, amountSpecified) > RISK_THRESHOLD_BPS;
    }

    function recommendedSlippageBps(PoolKey calldata key, bool zeroForOne, int256 amountSpecified)
        external
        view
        returns (uint256)
    {
        uint256 impact = estimatedImpactBps(key, zeroForOne, amountSpecified);
        uint256 recommendation = impact + 5;
        return recommendation > 500 ? 500 : recommendation;
    }

    /// @notice Step 2 of the protected flow. Reads the fulfilled random candidate,
    ///         marks the swap settled, and triggers the actual pool interaction.
    /// @dev FIX: `pending.settled = true` is now set BEFORE the external call to
    ///      poolManager.unlock(...), following checks-effects-interactions. The
    ///      previous version set it after, which left a reentrancy window where
    ///      unlockCallback's external token transfers (or a malicious token with
    ///      transfer hooks) could re-enter settleSwap for the same swapId before
    ///      `settled` was flipped, allowing a potential double-settlement.
    function settleSwap(uint256 swapId) external returns (uint160 sqrtPriceLimitX96) {
        PendingSwap storage pending = pendingSwaps[swapId];
        if (pending.trader != msg.sender) revert NotTrader();
        if (pending.settled) revert AlreadySettled();
        if (block.timestamp > pending.deadline) revert SwapExpired();

        (bool fulfilled, uint8 candidateIndex) = randomnessConsumer.resultForSwap(swapId);
        if (!fulfilled) revert RandomnessNotReady();

        sqrtPriceLimitX96 = directionalCandidatePrice(
            pending.sqrtPriceAtCommit, candidateIndex, pending.zeroForOne
        );

        // Effect before interaction.
        pending.settled = true;

        // Pass the already-resolved candidateIndex through explicitly instead of
        // having unlockCallback re-query the randomness consumer a second time —
        // avoids relying on the consumer returning a consistent answer twice.
        poolManager.unlock(abi.encode(swapId, candidateIndex, sqrtPriceLimitX96));

        // Credit the bond back rather than sending it directly: a push transfer
        // here would let a trader with a deliberately reverting receive() brick
        // their own settlement permanently. Pull it via withdrawBond() instead.
        unclaimedBond[pending.trader] += COMMIT_BOND;

        emit SwapSettled(swapId, candidateIndex, sqrtPriceLimitX96);
    }

    function cancelExpiredSwap(uint256 swapId) external {
        PendingSwap storage pending = pendingSwaps[swapId];
        if (pending.trader != msg.sender) revert NotTrader();
        if (block.timestamp <= pending.deadline) revert CannotCancelBeforeExpiry();
        if (pending.settled) revert AlreadySettled();
        pending.settled = true;
        unclaimedBond[pending.trader] += COMMIT_BOND;
        emit SwapCancelled(swapId, msg.sender);
    }

    /// @notice Pull-payment withdrawal for bonds credited by settleSwap or
    ///         cancelExpiredSwap. Kept separate from those functions so a
    ///         trader whose receive()/fallback() reverts can never brick their
    ///         own settlement or cancellation — only their own later withdrawal.
    function withdrawBond() external {
        uint256 amount = unclaimedBond[msg.sender];
        if (amount == 0) revert NoBondToWithdraw();
        unclaimedBond[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert BondTransferFailed();
        emit BondWithdrawn(msg.sender, amount);
    }

    /// @dev Called by PoolManager after settleSwap invokes unlock(). Performs the
    ///      actual swap and settles/takes the resulting token deltas against the
    ///      original trader.
    function unlockCallback(bytes calldata rawData) external onlyPoolManager returns (bytes memory) {
        (uint256 swapId, /* uint8 candidateIndex */, uint160 sqrtPriceLimitX96) =
            abi.decode(rawData, (uint256, uint8, uint160));

        PendingSwap storage pending = pendingSwaps[swapId];
        if (pending.amountSpecified >= 0) revert ExactInputOnly();

        settling = true;
        BalanceDelta delta = poolManager.swap(
            pending.key,
            SwapParams({
                zeroForOne: pending.zeroForOne,
                amountSpecified: pending.amountSpecified,
                sqrtPriceLimitX96: sqrtPriceLimitX96
            }),
            bytes("")
        );
        settling = false;

        int128 amount0 = delta.amount0();
        int128 amount1 = delta.amount1();
        if (amount0 < 0) {
            CurrencySettler.settle(pending.key.currency0, poolManager, pending.trader, uint256(uint128(-amount0)), false);
        } else if (amount0 > 0) {
            CurrencySettler.take(pending.key.currency0, poolManager, pending.trader, uint256(uint128(amount0)), false);
        }
        if (amount1 < 0) {
            CurrencySettler.settle(pending.key.currency1, poolManager, pending.trader, uint256(uint128(-amount1)), false);
        } else if (amount1 > 0) {
            CurrencySettler.take(pending.key.currency1, poolManager, pending.trader, uint256(uint128(amount1)), false);
        }

        // Premium is based on the amount actually filled, not the originally
        // committed amountSpecified: the sqrtPriceLimitX96 bound can partially
        // fill the swap (that's the whole point of the candidate-price band), so
        // charging against the committed intent would overcharge a partial fill.
        uint256 actualAmountIn = pending.zeroForOne
            ? (amount0 < 0 ? uint256(uint128(-amount0)) : 0)
            : (amount1 < 0 ? uint256(uint128(-amount1)) : 0);
        _recapturePremiumToLPs(swapId, pending, actualAmountIn);
        return bytes("");
    }

    /// @notice Charges an extra fee premium (on top of the swap itself) on
    ///         protected-lane swaps and routes it to in-range LPs.
    /// @dev Uses PoolManager.donate(), which credits the amount directly into the
    ///      pool's feeGrowthGlobal accounting — the same mechanism regular swap
    ///      fees use — so it pays out to LPs proportional to liquidity share with
    ///      no separate claims/distribution contract. donate() reverts if the
    ///      pool has no active in-range liquidity, which can't happen here since
    ///      the swap just above required liquidity to execute at all.
    function _recapturePremiumToLPs(uint256 swapId, PendingSwap storage pending, uint256 actualAmountIn) internal {
        uint256 premiumAmount = (actualAmountIn * PROTECTED_LANE_FEE_PREMIUM_BPS) / 10_000;
        if (premiumAmount == 0) return;

        poolManager.donate(
            pending.key,
            pending.zeroForOne ? premiumAmount : 0,
            pending.zeroForOne ? 0 : premiumAmount,
            bytes("")
        );
        CurrencySettler.settle(
            pending.zeroForOne ? pending.key.currency0 : pending.key.currency1,
            poolManager,
            pending.trader,
            premiumAmount,
            false
        );

        emit PremiumRecaptured(swapId, pending.zeroForOne, premiumAmount);
    }

    /// @dev Keeps zero-for-one limits below spot and one-for-zero limits above spot.
    ///      NOTE: this sets a slippage BOUND, not a settlement target — see the
    ///      contract-level @dev comment for the honest explanation of what
    ///      "randomized" actually means in this design.
    function directionalCandidatePrice(uint160 basePrice, uint8 index, bool zeroForOne)
        public
        pure
        returns (uint160)
    {
        require(index < NUM_CANDIDATES, "Invalid candidate");
        uint256 distance = (index + 1) * PRICE_BAND_BPS / NUM_CANDIDATES;
        int256 offset = zeroForOne ? -int256(distance) : int256(distance);
        int256 adjusted = int256(uint256(basePrice))
            + (int256(uint256(basePrice)) * offset) / 10_000;
        require(adjusted > 0 && adjusted <= int256(uint256(type(uint160).max)), "Price overflow");
        return uint160(uint256(adjusted));
    }
}

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

interface ISwapRandomnessConsumer {
    function requestRandomness(uint256 swapId) external returns (uint256 requestId);
    function resultForSwap(uint256 swapId) external view returns (bool fulfilled, uint8 candidateIndex);
}

contract ProtectedSwapHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    error NotTrader();
    error AlreadySettled();
    error RandomnessNotReady();
    error SwapExpired();
    error InvalidDeadline();
    error ExactInputOnly();

    uint256 public constant RISK_THRESHOLD_BPS = 50;
    uint256 public constant PRICE_BAND_BPS = 20;
    uint8 public constant NUM_CANDIDATES = 5;

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

    event SwapCommitted(address indexed trader, uint256 indexed swapId, uint256 indexed requestId);
    event SwapSettled(uint256 indexed swapId, uint8 candidateIndex, uint160 sqrtPriceLimitX96);

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

    function _beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        internal
        pure
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function commitSwap(
        PoolKey calldata key,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceAtCommit,
        uint256 deadline
    ) external returns (uint256 swapId) {
        if (deadline <= block.timestamp) revert InvalidDeadline();

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

    /// @notice Returns the approximate impact in basis points for UI routing.
    /// @dev This is intentionally conservative for the hackathon and should be
    ///      replaced with exact tick math before production deployment.
    function estimatedImpactBps(PoolKey calldata key, int256 amountSpecified)
        public
        view
        returns (uint256)
    {
        uint128 liquidity = poolManager.getLiquidity(key.toId());
        if (liquidity == 0 || amountSpecified == 0) return 0;
        uint256 amount = uint256(amountSpecified < 0 ? -amountSpecified : amountSpecified);
        return (amount * 10_000) / uint256(liquidity);
    }

    function isProtected(PoolKey calldata key, int256 amountSpecified) public view returns (bool) {
        return estimatedImpactBps(key, amountSpecified) > RISK_THRESHOLD_BPS;
    }

    function recommendedSlippageBps(PoolKey calldata key, int256 amountSpecified)
        external
        view
        returns (uint256)
    {
        uint256 impact = estimatedImpactBps(key, amountSpecified);
        // Keep a small floor for normal pool movement and cap the UI value.
        uint256 recommendation = impact + 5;
        return recommendation > 500 ? 500 : recommendation;
    }

    function settleSwap(uint256 swapId) external returns (uint160 sqrtPriceLimitX96) {
        PendingSwap storage pending = pendingSwaps[swapId];
        if (pending.trader != msg.sender) revert NotTrader();
        if (pending.settled) revert AlreadySettled();
        if (block.timestamp > pending.deadline) revert SwapExpired();

        (bool fulfilled, uint8 candidateIndex) = randomnessConsumer.resultForSwap(swapId);
        if (!fulfilled) revert RandomnessNotReady();

        sqrtPriceLimitX96 = candidatePrice(pending.sqrtPriceAtCommit, candidateIndex);
        poolManager.unlock(abi.encode(swapId));
        pending.settled = true;
        emit SwapSettled(swapId, candidateIndex, sqrtPriceLimitX96);
    }

    function unlockCallback(bytes calldata rawData) external onlyPoolManager returns (bytes memory) {
        uint256 swapId = abi.decode(rawData, (uint256));
        PendingSwap storage pending = pendingSwaps[swapId];
        if (pending.amountSpecified >= 0) revert ExactInputOnly();

        BalanceDelta delta = poolManager.swap(
            pending.key,
            SwapParams({
                zeroForOne: pending.zeroForOne,
                amountSpecified: pending.amountSpecified,
                sqrtPriceLimitX96: candidatePrice(pending.sqrtPriceAtCommit, _candidateIndex(swapId))
            }),
            bytes("")
        );

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
        return bytes("");
    }

    function _candidateIndex(uint256 swapId) internal view returns (uint8 index) {
        (bool fulfilled, uint8 selected) = randomnessConsumer.resultForSwap(swapId);
        if (!fulfilled) revert RandomnessNotReady();
        return selected;
    }

    function candidatePrice(uint160 basePrice, uint8 index) public pure returns (uint160) {
        require(index < NUM_CANDIDATES, "Invalid candidate");
        int256 offset = int256(uint256(index) * (2 * PRICE_BAND_BPS)) / int256(uint256(NUM_CANDIDATES - 1))
            - int256(PRICE_BAND_BPS);
        int256 adjusted = int256(uint256(basePrice)) + (int256(uint256(basePrice)) * offset) / 10_000;
        require(adjusted > 0 && adjusted <= int256(uint256(type(uint160).max)), "Price overflow");
        return uint160(uint256(adjusted));
    }
}

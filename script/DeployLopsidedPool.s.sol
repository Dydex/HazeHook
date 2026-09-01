// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";

import {BaseScript} from "../lib/v4-template/script/base/BaseScript.sol";
import {LiquidityHelpers} from "../lib/v4-template/script/base/LiquidityHelpers.sol";

interface IWETH9 is IERC20 {
    function deposit() external payable;
}

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice Deploys a SECOND HTT/WETH pool at a more realistic, lopsided price
///         (1 WETH = 10,000 HTT, instead of the original pool's accidental
///         ~1:1 parity) and seeds it with liquidity.
/// @dev A liquidity add can only ever match a pool's EXISTING price — it can't
///      reprice one. Repricing the original pool would require an actual swap
///      big enough to move it, which is expensive and, given how the price
///      band interacts with a swap that size, would mostly partial-fill
///      rather than land where intended. A fresh pool at a different fee tier
///      (500 instead of 3000, giving it a distinct pool identity) sidesteps
///      that entirely: initialize it at whatever price you want from the
///      start. The original 3000-fee pool is left exactly as it was — this
///      doesn't touch it.
/// @dev Split into several internal functions (rather than one run()) to keep
///      each function's live local-variable count low enough for the non-IR
///      compiler — a single-function version hit "stack too deep".
contract DeployLopsidedPoolScript is BaseScript, LiquidityHelpers {
    address constant TEST_TOKEN = 0xDE8A1613Ee95a0Ee72fF5B72Af2aAdFe6C783F3D;
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant HOOK = 0x47eBA0b231D3cec1D74597dDAB60df6a41048080;

    uint24 constant LP_FEE = 500; // 0.05% — distinct fee tier, distinct pool identity
    int24 constant TICK_SPACING = 10; // conventional pairing for the 500 fee tier

    // sqrtPriceX96 for 1 WETH = 10,000 HTT (price = 0.0001 WETH per HTT)
    uint160 constant STARTING_PRICE = 792281625142643392428113920;

    function run() external {
        uint256 wethWrapAmount = vm.envOr("WETH_WRAP_AMOUNT", uint256(0.05 ether));

        vm.startBroadcast();
        (uint256 wethAmount, uint256 httAmount) = _prepareTokens(wethWrapAmount);
        _addLiquidity(wethAmount, httAmount);
        vm.stopBroadcast();

        console2.log("New pool fee tier:", LP_FEE);
        console2.log("WETH deposited:", wethAmount);
        console2.log("HTT deposited (approx):", httAmount);
    }

    function _prepareTokens(uint256 wethWrapAmount) internal returns (uint256 wethAmount, uint256 httAmount) {
        IWETH9 weth = IWETH9(WETH);
        weth.deposit{value: wethWrapAmount}();

        // Use the full WETH balance (existing + freshly wrapped) rather than
        // just what was wrapped just now, so nothing sits idle.
        wethAmount = weth.balanceOf(deployerAddress);
        httAmount = wethAmount * 10_000; // matches STARTING_PRICE's ratio
        IMintable(TEST_TOKEN).mint(deployerAddress, httAmount + 1000 ether); // generous buffer

        IERC20(TEST_TOKEN).approve(address(permit2), type(uint256).max);
        permit2.approve(TEST_TOKEN, address(positionManager), type(uint160).max, type(uint48).max);
        weth.approve(address(permit2), type(uint256).max);
        permit2.approve(WETH, address(positionManager), type(uint160).max, type(uint48).max);
    }

    function _buildPoolKey() internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(TEST_TOKEN),
            currency1: Currency.wrap(WETH),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(HOOK)
        });
    }

    function _tickRangeAndLiquidity(uint256 wethAmount, uint256 httAmount)
        internal
        pure
        returns (int24 tickLower, int24 tickUpper, uint128 liquidity)
    {
        int24 currentTick = TickMath.getTickAtSqrtPrice(STARTING_PRICE);
        tickLower = truncateTickSpacing(currentTick - 750 * TICK_SPACING, TICK_SPACING);
        tickUpper = truncateTickSpacing(currentTick + 750 * TICK_SPACING, TICK_SPACING);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            STARTING_PRICE, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), httAmount, wethAmount
        );
    }

    function _addLiquidity(uint256 wethAmount, uint256 httAmount) internal {
        PoolKey memory poolKey = _buildPoolKey();
        bytes memory hookData = new bytes(0);
        (int24 tickLower, int24 tickUpper, uint128 liquidity) = _tickRangeAndLiquidity(wethAmount, httAmount);

        (bytes memory actions, bytes[] memory mintParams) = _mintLiquidityParams(
            poolKey, tickLower, tickUpper, liquidity, httAmount + 1, wethAmount + 1, deployerAddress, hookData
        );

        bytes[] memory params = new bytes[](2);
        params[0] =
            abi.encodeWithSelector(positionManager.initializePool.selector, poolKey, STARTING_PRICE, hookData);
        params[1] = abi.encodeWithSelector(
            positionManager.modifyLiquidities.selector, abi.encode(actions, mintParams), block.timestamp + 3600
        );
        positionManager.multicall(params);
    }
}

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

/// @notice The lopsided HTT/WETH pool config used since the first deployment
///         (1 WETH = 10,000 HTT), pointed at the NEW HazeHook deployed by
///         RedeployHook.s.sol. A pool's identity includes its hook address, so
///         this is unavoidably a fresh pool — the old one (still sitting at
///         the retired hook) is left untouched, not migrated.
contract RedeployPoolScript is BaseScript, LiquidityHelpers {
    address constant TEST_TOKEN = 0xDE8A1613Ee95a0Ee72fF5B72Af2aAdFe6C783F3D;
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    // Predicted by a dry run of RedeployHook.s.sol's HookMiner.find() call —
    // deterministic given HazeHook's bytecode + constructor args + flags, so
    // this matches whatever RedeployHook.s.sol actually deploys as long as
    // HazeHook.sol isn't changed again in between.
    address constant HOOK = 0xdE8563cd71256d980AB37c7DeD90671915d30080;

    uint24 constant LP_FEE = 500;
    int24 constant TICK_SPACING = 10;

    // sqrtPriceX96 for 1 WETH = 10,000 HTT (price = 0.0001 WETH per HTT)
    uint160 constant STARTING_PRICE = 792281625142643392428113920;

    function run() external {
        uint256 wethWrapAmount = vm.envOr("WETH_WRAP_AMOUNT", uint256(0));

        vm.startBroadcast();
        (uint256 wethAmount, uint256 httAmount) = _prepareTokens(wethWrapAmount);
        _addLiquidity(wethAmount, httAmount);
        vm.stopBroadcast();

        console2.log("New pool hook:", HOOK);
        console2.log("WETH deposited:", wethAmount);
        console2.log("HTT deposited (approx):", httAmount);
    }

    function _prepareTokens(uint256 wethWrapAmount) internal returns (uint256 wethAmount, uint256 httAmount) {
        IWETH9 weth = IWETH9(WETH);
        if (wethWrapAmount > 0) weth.deposit{value: wethWrapAmount}();

        // Reuse whatever WETH is already loose in the deployer's wallet
        // (1.41+ WETH as of this script being written) rather than wrapping
        // fresh ETH — nothing needs to sit idle.
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

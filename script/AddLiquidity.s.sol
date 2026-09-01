// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
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

/// @notice Adds a much deeper liquidity position to the already-initialized
///         HTT/WETH pool, so test swaps stop suffering the extreme slippage
///         that came from DeployPool.s.sol's original razor-thin seed
///         (~0.02 WETH). Does NOT call initializePool — the pool already
///         exists and has since moved off its 1:1 starting price, so this
///         reads the pool's real live price via StateLibrary rather than
///         assuming 1:1, to size the position correctly.
/// @dev Set WETH_ADD_AMOUNT (default 1.4 ether) to how much Sepolia ETH to
///      wrap and deposit as liquidity — your deployer wallet needs at least
///      that much real ETH plus gas.
contract AddLiquidityScript is BaseScript, LiquidityHelpers {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    address constant TEST_TOKEN = 0xDE8A1613Ee95a0Ee72fF5B72Af2aAdFe6C783F3D;
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant HOOK = 0x47eBA0b231D3cec1D74597dDAB60df6a41048080;

    uint24 constant LP_FEE = 3000;
    int24 constant TICK_SPACING = 60;

    function run() external {
        uint256 wethAddAmount = vm.envOr("WETH_ADD_AMOUNT", uint256(1.4 ether));

        PoolKey memory poolKey = PoolKey({
            currency0: Currency.wrap(TEST_TOKEN),
            currency1: Currency.wrap(WETH),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(HOOK)
        });

        (uint160 currentSqrtPrice,,,) = poolManager.getSlot0(poolKey.toId());
        require(currentSqrtPrice != 0, "Pool not initialized");

        vm.startBroadcast();

        _mintAndDeposit(wethAddAmount);
        _addLiquidity(poolKey, currentSqrtPrice, wethAddAmount);

        vm.stopBroadcast();

        console2.log("WETH deposited as liquidity:", wethAddAmount);
    }

    function _mintAndDeposit(uint256 wethAddAmount) internal {
        // HTT surplus buffer: the pool has drifted off 1:1, so mint extra to
        // absorb the deviation without hitting the mint's slippage cap.
        IMintable(TEST_TOKEN).mint(deployerAddress, wethAddAmount + 1 ether);
        IWETH9(WETH).deposit{value: wethAddAmount}();

        IERC20(TEST_TOKEN).approve(address(permit2), type(uint256).max);
        permit2.approve(TEST_TOKEN, address(positionManager), type(uint160).max, type(uint48).max);
        IERC20(WETH).approve(address(permit2), type(uint256).max);
        permit2.approve(WETH, address(positionManager), type(uint160).max, type(uint48).max);
    }

    function _addLiquidity(PoolKey memory poolKey, uint160 currentSqrtPrice, uint256 wethAddAmount) internal {
        bytes memory hookData = new bytes(0);
        int24 currentTick = TickMath.getTickAtSqrtPrice(currentSqrtPrice);
        int24 tickLower = truncateTickSpacing(currentTick - 750 * TICK_SPACING, TICK_SPACING);
        int24 tickUpper = truncateTickSpacing(currentTick + 750 * TICK_SPACING, TICK_SPACING);

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            currentSqrtPrice,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            wethAddAmount + 1 ether,
            wethAddAmount
        );

        (bytes memory actions, bytes[] memory mintParams) = _mintLiquidityParams(
            poolKey,
            tickLower,
            tickUpper,
            liquidity,
            wethAddAmount + 1 ether + 1,
            wethAddAmount + 1,
            deployerAddress,
            hookData
        );

        positionManager.modifyLiquidities(abi.encode(actions, mintParams), block.timestamp + 3600);
    }
}

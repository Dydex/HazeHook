// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";

import {BaseScript} from "../lib/v4-template/script/base/BaseScript.sol";
import {LiquidityHelpers} from "../lib/v4-template/script/base/LiquidityHelpers.sol";

interface IWETH9 is IERC20 {
    function deposit() external payable;
}

/// @notice Deploys one mock ERC20 test token, wraps Sepolia ETH into WETH, creates
///         a v4 pool pairing the two that uses HazeHook, and seeds it with a wide
///         liquidity position. Reads as TOKEN/WETH instead of two anonymous mocks.
/// @dev Must run AFTER DeployHook.s.sol — set HOOK_ADDRESS to that deploy's printed
///      HazeHook address. Your deployer wallet needs Sepolia ETH covering both gas
///      and WETH_AMOUNT (default 0.02 ether) — the script wraps it via WETH9.deposit().
///      Split into several internal functions (rather than one run()) to keep each
///      function's live local-variable count low enough for the non-IR compiler —
///      the original single-function version hit "stack too deep".
contract DeployPoolScript is BaseScript, LiquidityHelpers {
    using CurrencyLibrary for Currency;

    address constant SEPOLIA_WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;

    uint24 constant LP_FEE = 3000; // 0.30%
    int24 constant TICK_SPACING = 60;
    uint160 constant STARTING_PRICE = 2 ** 96; // sqrtPriceX96 for a 1:1 starting price

    function run() external {
        address hookAddress = vm.envAddress("HOOK_ADDRESS");
        require(hookAddress != address(0), "Set HOOK_ADDRESS to the deployed HazeHook address");
        uint256 wethAmount = vm.envOr("WETH_AMOUNT", uint256(0.02 ether));

        vm.startBroadcast();
        _deployAndSeed(hookAddress, wethAmount);
        vm.stopBroadcast();
    }

    function _deployAndSeed(address hookAddress, uint256 wethAmount) internal {
        MockERC20 testToken = new MockERC20("Haze Test Token", "HTT", 18);
        testToken.mint(deployerAddress, 1_000_000 ether);

        IWETH9 weth = IWETH9(SEPOLIA_WETH);
        weth.deposit{value: wethAmount}();

        PoolKey memory poolKey = _buildPoolKey(hookAddress, address(testToken));

        // LiquidityHelpers.tokenApprovals() is hardwired to BaseScript's
        // placeholder token0/token1 constants, not the tokens used here.
        testToken.approve(address(permit2), type(uint256).max);
        permit2.approve(address(testToken), address(positionManager), type(uint160).max, type(uint48).max);
        weth.approve(address(permit2), type(uint256).max);
        permit2.approve(address(weth), address(positionManager), type(uint160).max, type(uint48).max);

        _initializeAndMint(poolKey, wethAmount);

        console2.log("Test token:", address(testToken));
        console2.log("WETH:", SEPOLIA_WETH);
        console2.log("Pool currency0:", Currency.unwrap(poolKey.currency0));
        console2.log("Pool currency1:", Currency.unwrap(poolKey.currency1));
        console2.log("Hook:", hookAddress);
    }

    function _buildPoolKey(address hookAddress, address testToken) internal pure returns (PoolKey memory) {
        (Currency currency0, Currency currency1) = testToken < SEPOLIA_WETH
            ? (Currency.wrap(testToken), Currency.wrap(SEPOLIA_WETH))
            : (Currency.wrap(SEPOLIA_WETH), Currency.wrap(testToken));

        return PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hookAddress)
        });
    }

    function _initializeAndMint(PoolKey memory poolKey, uint256 wethAmount) internal {
        bytes memory hookData = new bytes(0);
        int24 currentTick = TickMath.getTickAtSqrtPrice(STARTING_PRICE);
        int24 tickLower = truncateTickSpacing(currentTick - 750 * TICK_SPACING, TICK_SPACING);
        int24 tickUpper = truncateTickSpacing(currentTick + 750 * TICK_SPACING, TICK_SPACING);

        // Starting price is nominally 1:1, so deposit the test token 1:1 against
        // however much WETH got wrapped — amount0/amount1 order doesn't matter
        // here since both amounts are equal.
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            STARTING_PRICE,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            wethAmount,
            wethAmount
        );

        (bytes memory actions, bytes[] memory mintParams) = _mintLiquidityParams(
            poolKey, tickLower, tickUpper, liquidity, wethAmount + 1, wethAmount + 1, deployerAddress, hookData
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

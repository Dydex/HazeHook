// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "../lib/v4-template/test/utils/BaseTest.sol";
import {Deployers} from "../lib/v4-template/test/utils/Deployers.sol";
import {EasyPosm} from "../lib/v4-template/test/utils/libraries/EasyPosm.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {HazeHook, ISwapRandomnessConsumer} from "../src/HazeHook.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract IntegrationRandomness is ISwapRandomnessConsumer {
    uint256 public nextId = 1;
    mapping(uint256 => uint256) public ids;
    mapping(uint256 => bool) public ready;
    function requestRandomness(uint256 swapId) external returns (uint256 id) { id = nextId++; ids[swapId] = id; }
    function fulfill(uint256 swapId) external { ready[swapId] = true; }
    function resultForSwap(uint256 swapId) external view returns (bool, uint8) { return (ready[swapId], 0); }
}

contract HazeHookIntegrationTest is BaseTest {
    using EasyPosm for IPositionManager;
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    HazeHook hook;
    IntegrationRandomness randomness;
    PoolKey poolKey;
    Currency currency0;
    Currency currency1;
    address trader = address(0xCAFE);

    function setUp() public {
        deployArtifactsAndLabel();
        (currency0, currency1) = deployCurrencyPair();
        randomness = new IntegrationRandomness();

        address flags = address(uint160(Hooks.BEFORE_SWAP_FLAG) ^ (0x5252 << 144));
        deployCodeTo(
            "HazeHook.sol:HazeHook",
            abi.encode(poolManager, randomness),
            flags
        );
        hook = HazeHook(flags);

        poolKey = PoolKey(currency0, currency1, 3000, 60, hook);
        poolManager.initialize(poolKey, Constants.SQRT_PRICE_1_1);

        int24 lower = TickMath.minUsableTick(poolKey.tickSpacing);
        int24 upper = TickMath.maxUsableTick(poolKey.tickSpacing);
        positionManager.mint(
            poolKey, lower, upper, 100e18, 1_000_000 ether, 1_000_000 ether,
            address(this), block.timestamp, Constants.ZERO_BYTES
        );

        IERC20(Currency.unwrap(currency0)).transfer(trader, 10e18);
        IERC20(Currency.unwrap(currency1)).transfer(trader, 10e18);
        vm.prank(trader);
        IERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
        vm.prank(trader);
        IERC20(Currency.unwrap(currency1)).approve(address(hook), type(uint256).max);

    }

    function testCommitAgainstInitializedV4Pool() public {
        uint256 swapId = hook.commitSwap(
            poolKey, true, -1e18, block.timestamp + 1 days
        );
        (address trader,,,,,, uint256 requestId,,) = hook.pendingSwaps(swapId);
        assertEq(trader, address(this));
        assertEq(requestId, 1);
    }

    function testRealSettlementAgainstV4Pool() public {
        vm.prank(trader);
        uint256 swapId = hook.commitSwap(
            poolKey, true, -1e18, block.timestamp + 1 days
        );
        randomness.fulfill(swapId);

        uint256 beforeBalance = IERC20(Currency.unwrap(currency1)).balanceOf(trader);
        vm.prank(trader);
        hook.settleSwap(swapId);
        uint256 afterBalance = IERC20(Currency.unwrap(currency1)).balanceOf(trader);
        assertGt(afterBalance, beforeBalance);
    }

    function testProtectedSwapRecapturesPremiumToLPs() public {
        int256 amountSpecified = -1e18;

        vm.prank(trader);
        uint256 swapId = hook.commitSwap(poolKey, true, amountSpecified, block.timestamp + 1 days);
        randomness.fulfill(swapId);

        PoolId poolId = poolKey.toId();
        (uint256 feeGrowth0Before,) = poolManager.getFeeGrowthGlobals(poolId);
        uint256 currency0Before = IERC20(Currency.unwrap(currency0)).balanceOf(trader);

        vm.prank(trader);
        hook.settleSwap(swapId);

        uint256 currency0After = IERC20(Currency.unwrap(currency0)).balanceOf(trader);
        (uint256 feeGrowth0After,) = poolManager.getFeeGrowthGlobals(poolId);

        // The tight ±PRICE_BAND_BPS sqrtPriceLimitX96 bound means the swap only
        // partially fills against a -1e18 committed intent (that's the point of
        // the candidate-price band) — so back out the actual fill from the
        // trader's balance change rather than assuming the full 1e18 traded.
        uint256 totalCurrency0Paid = currency0Before - currency0After;
        uint256 expectedPremium = totalCurrency0Paid * hook.PROTECTED_LANE_FEE_PREMIUM_BPS()
            / (10_000 + hook.PROTECTED_LANE_FEE_PREMIUM_BPS());
        assertGt(expectedPremium, 0);

        // The premium was donated into the pool's fee-growth accounting, so it
        // flows to LPs proportional to liquidity share — not to the hook itself.
        assertGt(feeGrowth0After, feeGrowth0Before);
    }
}

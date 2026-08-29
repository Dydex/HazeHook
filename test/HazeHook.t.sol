// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {HazeHook, ISwapRandomnessConsumer} from "../src/HazeHook.sol";

contract TestRandomnessConsumer is ISwapRandomnessConsumer {
    uint256 public nextRequestId = 1;
    mapping(uint256 => uint256) public requestForSwap;
    mapping(uint256 => bool) public fulfilled;
    mapping(uint256 => uint8) public candidateForSwap;

    function requestRandomness(uint256 swapId) external returns (uint256 requestId) {
        requestId = nextRequestId++;
        requestForSwap[swapId] = requestId;
    }

    function fulfill(uint256 swapId, uint8 candidateIndex) external {
        fulfilled[swapId] = true;
        candidateForSwap[swapId] = candidateIndex;
    }

    function resultForSwap(uint256 swapId) external view returns (bool, uint8) {
        return (fulfilled[swapId], candidateForSwap[swapId]);
    }
}

contract HazeHookTest is Test {
    using PoolIdLibrary for PoolKey;

    HazeHook hook;
    TestRandomnessConsumer randomness;
    PoolKey key;
    address trader = address(0xBEEF);

    function setUp() public {
        randomness = new TestRandomnessConsumer();
        address flags = address(uint160(Hooks.BEFORE_SWAP_FLAG) ^ (0x5151 << 144));
        deployCodeTo(
            "HazeHook.sol:HazeHook",
            abi.encode(IPoolManager(address(1)), randomness),
            flags
        );
        hook = HazeHook(flags);

        key = PoolKey({
            currency0: Currency.wrap(address(0x1000)),
            currency1: Currency.wrap(address(0x2000)),
            fee: 3000,
            tickSpacing: 60,
            hooks: hook
        });

        // commitSwap()/estimatedImpactBps() read the live pool price and liquidity
        // via StateLibrary, which calls extsload on the PoolManager. These unit
        // tests use a fake manager address (address(1)) with no code, so stub
        // extsload per-slot: a plausible sqrtPriceX96 (1e18, well within
        // TickMath's valid range) and a liquidity depth (1e9) shallow enough that
        // a 1e18 exact-input swap produces a real, meaningfully large price
        // impact under SqrtPriceMath (as opposed to the old amount/liquidity
        // ratio, which wasn't unit-comparable in the first place).
        PoolId poolId = key.toId();
        bytes32 stateSlot = StateLibrary._getPoolStateSlot(poolId);
        bytes32 liquiditySlot = bytes32(uint256(stateSlot) + StateLibrary.LIQUIDITY_OFFSET);

        vm.mockCall(
            address(1),
            abi.encodeWithSignature("extsload(bytes32)", stateSlot),
            abi.encode(bytes32(uint256(1e18)))
        );
        vm.mockCall(
            address(1),
            abi.encodeWithSignature("extsload(bytes32)", liquiditySlot),
            abi.encode(bytes32(uint256(1e9)))
        );
    }

    function testCommitStoresPendingSwapAndRequestsRandomness() public {
        vm.prank(trader);
        uint256 swapId = hook.commitSwap(key, true, -1e18, block.timestamp + 1 days);

        (address owner,,,,,, uint256 requestId, uint256 deadline, bool settled) = hook.pendingSwaps(swapId);
        assertEq(owner, trader);
        assertEq(requestId, 1);
        assertEq(deadline, block.timestamp + 1 days);
        assertFalse(settled);
    }

    function testCannotCommitExactOutputSwap() public {
        vm.prank(trader);
        vm.expectRevert(HazeHook.ExactInputOnly.selector);
        hook.commitSwap(key, true, 1e18, block.timestamp + 1 days);
    }

    function testCannotCommitSwapBelowRiskThreshold() public {
        // Against the mocked 1e9 liquidity, a tiny amount rounds down to 0bps impact.
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(HazeHook.BelowRiskThreshold.selector, 0));
        hook.commitSwap(key, true, -1e14, block.timestamp + 1 days);
    }

    function testCannotSettleBeforeRandomness() public {
        vm.prank(trader);
        uint256 swapId = hook.commitSwap(key, true, -1e18, block.timestamp + 1 days);

        vm.prank(trader);
        vm.expectRevert(HazeHook.RandomnessNotReady.selector);
        hook.settleSwap(swapId);
    }

    function testSettlementUsesFulfilledCandidate() public {
        vm.prank(trader);
        uint256 swapId = hook.commitSwap(key, true, -1e18, block.timestamp + 1 days);
        randomness.fulfill(swapId, 4);

        vm.prank(trader);
        vm.expectRevert();
        hook.settleSwap(swapId);
    }

    function testOnlyTraderCanSettle() public {
        vm.prank(trader);
        uint256 swapId = hook.commitSwap(key, true, -1e18, block.timestamp + 1 days);
        randomness.fulfill(swapId, 2);

        vm.expectRevert(HazeHook.NotTrader.selector);
        hook.settleSwap(swapId);
    }

    function testExpiredSwapCanBeCancelledByTrader() public {
        vm.prank(trader);
        uint256 swapId = hook.commitSwap(key, true, -1e18, block.timestamp + 1 days);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(trader);
        hook.cancelExpiredSwap(swapId);

        (,,,,,,,, bool settled) = hook.pendingSwaps(swapId);
        assertTrue(settled);
    }

    function testCandidatePricesStayWithinBand() public view {
        uint160 base = 1e18;
        for (uint8 i = 0; i < hook.NUM_CANDIDATES(); i++) {
            uint160 downPrice = hook.directionalCandidatePrice(base, i, true);
            assertLe(downPrice, base);
            assertGe(downPrice, 998e15);

            uint160 upPrice = hook.directionalCandidatePrice(base, i, false);
            assertGe(upPrice, base);
            assertLe(upPrice, 1_002e15);
        }
    }
}

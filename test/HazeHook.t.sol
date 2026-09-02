// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
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

/// @dev A contract "trader" whose receive() always reverts, used to exercise
///      _refundBond's pull-payment fallback path (unclaimedBond) — a plain
///      EOA can't hit that branch since sending it ETH never fails.
contract RevertingReceiver {
    receive() external payable {
        revert("nope");
    }
}

contract HazeHookTest is Test {
    using PoolIdLibrary for PoolKey;

    HazeHook hook;
    TestRandomnessConsumer randomness;
    PoolKey key;
    address trader = address(0xBEEF);
    uint256 bond;

    function setUp() public {
        vm.deal(trader, 10 ether); // covers COMMIT_BOND across every test
        randomness = new TestRandomnessConsumer();
        address flags = address(uint160(Hooks.BEFORE_SWAP_FLAG) ^ (0x5151 << 144));
        deployCodeTo(
            "HazeHook.sol:HazeHook",
            abi.encode(IPoolManager(address(1)), randomness),
            flags
        );
        hook = HazeHook(flags);
        // Read once here (not inline in a pranked call): vm.prank only applies
        // to the very next external call, and hook.COMMIT_BOND() is itself a
        // call — reading it inline as a {value: ...} argument would consume the
        // prank on that read instead of on commitSwap.
        bond = hook.COMMIT_BOND();

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
        uint256 swapId = hook.commitSwap{value: bond}(key, true, -1e18, block.timestamp + 1 days);

        (address owner,,,,,, uint256 requestId, uint256 deadline, bool settled) = hook.pendingSwaps(swapId);
        assertEq(owner, trader);
        assertEq(requestId, 1);
        assertEq(deadline, block.timestamp + 1 days);
        assertFalse(settled);
    }

    function testCannotCommitWithNoBond() public {
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(HazeHook.IncorrectBondAmount.selector, bond, 0));
        hook.commitSwap(key, true, -1e18, block.timestamp + 1 days);
    }

    function testCannotCommitWithWrongBondAmount() public {
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(HazeHook.IncorrectBondAmount.selector, bond, bond - 1));
        hook.commitSwap{value: bond - 1}(key, true, -1e18, block.timestamp + 1 days);

        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(HazeHook.IncorrectBondAmount.selector, bond, bond + 1));
        hook.commitSwap{value: bond + 1}(key, true, -1e18, block.timestamp + 1 days);
    }

    function testBondIsAutoRefundedOnCancel() public {
        vm.prank(trader);
        uint256 swapId = hook.commitSwap{value: bond}(key, true, -1e18, block.timestamp + 1 days);

        // Bond isn't refunded while the swap is still pending, and there's
        // nothing to pull yet either.
        assertEq(hook.unclaimedBond(trader), 0);
        vm.prank(trader);
        vm.expectRevert(HazeHook.NoBondToWithdraw.selector);
        hook.withdrawBond();

        vm.warp(block.timestamp + 1 days + 1);
        uint256 balanceBefore = trader.balance;
        vm.prank(trader);
        hook.cancelExpiredSwap(swapId);

        // Pushed straight back in the same call — nothing left to claim.
        assertEq(trader.balance, balanceBefore + bond);
        assertEq(hook.unclaimedBond(trader), 0);
    }

    function testBondFallsBackToUnclaimedWhenPushFails() public {
        RevertingReceiver badTrader = new RevertingReceiver();
        vm.deal(address(badTrader), 10 ether);

        vm.prank(address(badTrader));
        uint256 swapId = hook.commitSwap{value: bond}(key, true, -1e18, block.timestamp + 1 days);

        vm.warp(block.timestamp + 1 days + 1);
        uint256 balanceBefore = address(badTrader).balance;
        vm.prank(address(badTrader));
        hook.cancelExpiredSwap(swapId); // doesn't revert even though the push fails

        // Push failed (reverting receive()), so the balance didn't move yet —
        // the bond is parked in unclaimedBond instead, recoverable separately.
        assertEq(address(badTrader).balance, balanceBefore);
        assertEq(hook.unclaimedBond(address(badTrader)), bond);

        // withdrawBond() itself would also fail for the same reason (still a
        // push to the same reverting receive()) — confirms the bond isn't
        // silently lost, just genuinely stuck behind this wallet's own code.
        vm.prank(address(badTrader));
        vm.expectRevert(HazeHook.BondTransferFailed.selector);
        hook.withdrawBond();
        assertEq(hook.unclaimedBond(address(badTrader)), bond);
    }

    function testCannotCommitExactOutputSwap() public {
        vm.prank(trader);
        vm.expectRevert(HazeHook.ExactInputOnly.selector);
        hook.commitSwap{value: bond}(key, true, 1e18, block.timestamp + 1 days);
    }

    function testCannotCommitSwapBelowRiskThreshold() public {
        // Against the mocked 1e9 liquidity, a tiny amount rounds down to 0bps impact.
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(HazeHook.BelowRiskThreshold.selector, 0));
        hook.commitSwap{value: bond}(key, true, -1e14, block.timestamp + 1 days);
    }

    function testCannotSettleBeforeRandomness() public {
        vm.prank(trader);
        uint256 swapId = hook.commitSwap{value: bond}(key, true, -1e18, block.timestamp + 1 days);

        vm.prank(trader);
        vm.expectRevert(HazeHook.RandomnessNotReady.selector);
        hook.settleSwap(swapId);
    }

    function testSettlementUsesFulfilledCandidate() public {
        vm.prank(trader);
        uint256 swapId = hook.commitSwap{value: bond}(key, true, -1e18, block.timestamp + 1 days);
        randomness.fulfill(swapId, 4);

        vm.prank(trader);
        vm.expectRevert();
        hook.settleSwap(swapId);
    }

    function testOnlyTraderCanSettle() public {
        vm.prank(trader);
        uint256 swapId = hook.commitSwap{value: bond}(key, true, -1e18, block.timestamp + 1 days);
        randomness.fulfill(swapId, 2);

        vm.expectRevert(HazeHook.NotTrader.selector);
        hook.settleSwap(swapId);
    }

    function testExpiredSwapCanBeCancelledByTrader() public {
        vm.prank(trader);
        uint256 swapId = hook.commitSwap{value: bond}(key, true, -1e18, block.timestamp + 1 days);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(trader);
        hook.cancelExpiredSwap(swapId);

        (,,,,,,,, bool settled) = hook.pendingSwaps(swapId);
        assertTrue(settled);
    }

    function testCannotSettleAlreadyCancelledSwap() public {
        vm.prank(trader);
        uint256 swapId = hook.commitSwap{value: bond}(key, true, -1e18, block.timestamp + 1 days);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(trader);
        hook.cancelExpiredSwap(swapId);

        randomness.fulfill(swapId, 2);
        vm.prank(trader);
        vm.expectRevert(HazeHook.AlreadySettled.selector);
        hook.settleSwap(swapId);
    }

    function testCannotSettleAfterDeadline() public {
        vm.prank(trader);
        uint256 swapId = hook.commitSwap{value: bond}(key, true, -1e18, block.timestamp + 1 days);
        randomness.fulfill(swapId, 2);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(trader);
        vm.expectRevert(HazeHook.SwapExpired.selector);
        hook.settleSwap(swapId);
    }

    function testOnlyTraderCanCancel() public {
        vm.prank(trader);
        uint256 swapId = hook.commitSwap{value: bond}(key, true, -1e18, block.timestamp + 1 days);
        vm.warp(block.timestamp + 1 days + 1);

        vm.expectRevert(HazeHook.NotTrader.selector);
        hook.cancelExpiredSwap(swapId);
    }

    function testCannotCancelBeforeExpiry() public {
        vm.prank(trader);
        uint256 swapId = hook.commitSwap{value: bond}(key, true, -1e18, block.timestamp + 1 days);

        vm.prank(trader);
        vm.expectRevert(HazeHook.CannotCancelBeforeExpiry.selector);
        hook.cancelExpiredSwap(swapId);
    }

    function testCannotCancelAlreadySettledSwap() public {
        vm.prank(trader);
        uint256 swapId = hook.commitSwap{value: bond}(key, true, -1e18, block.timestamp + 1 days);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(trader);
        hook.cancelExpiredSwap(swapId);

        vm.prank(trader);
        vm.expectRevert(HazeHook.AlreadySettled.selector);
        hook.cancelExpiredSwap(swapId);
    }

    function testCannotCommitWithPastOrCurrentDeadline() public {
        vm.prank(trader);
        vm.expectRevert(HazeHook.InvalidDeadline.selector);
        hook.commitSwap{value: bond}(key, true, -1e18, block.timestamp);
    }

    function testCannotCommitAgainstInitializedPoolWithNoLiquidity() public {
        // Distinct from testCannotCommitAgainstUninitializedPool: this pool HAS a
        // real price (sqrtPriceX96 != 0), so it passes the PoolNotInitialized
        // check, but has zero active liquidity — estimatedImpactBps can't compute
        // a meaningful impact against zero liquidity, so it returns 0bps, which
        // correctly falls back to BelowRiskThreshold rather than a division/library
        // revert deeper in SqrtPriceMath.
        PoolId poolId = key.toId();
        bytes32 stateSlot = StateLibrary._getPoolStateSlot(poolId);
        bytes32 liquiditySlot = bytes32(uint256(stateSlot) + StateLibrary.LIQUIDITY_OFFSET);
        vm.mockCall(
            address(1),
            abi.encodeWithSignature("extsload(bytes32)", liquiditySlot),
            abi.encode(bytes32(uint256(0)))
        );

        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(HazeHook.BelowRiskThreshold.selector, 0));
        hook.commitSwap{value: bond}(key, true, -1e18, block.timestamp + 1 days);
    }

    function testEstimatedImpactIsZeroForZeroAmount() public view {
        assertEq(hook.estimatedImpactBps(key, true, 0), 0);
    }

    function testDirectionalCandidatePriceRevertsOnOverflow() public {
        // basePrice at TickMath's max valid sqrt price sits close enough to
        // type(uint160).max that even the largest upward (one-for-zero) offset —
        // the last candidate, +20bps — pushes the adjusted price past
        // type(uint160).max, hitting the "Price overflow" guard.
        uint8 topCandidateIndex = hook.NUM_CANDIDATES() - 1;
        vm.expectRevert("Price overflow");
        hook.directionalCandidatePrice(TickMath.MAX_SQRT_PRICE, topCandidateIndex, false);
    }

    function testCannotCommitAgainstUninitializedPool() public {
        // A pool whose slot0 has never been written reads back all-zero from
        // extsload, so sqrtPriceX96 == 0.
        PoolKey memory uninitKey = PoolKey({
            currency0: Currency.wrap(address(0x3000)),
            currency1: Currency.wrap(address(0x4000)),
            fee: 3000,
            tickSpacing: 60,
            hooks: hook
        });
        PoolId uninitId = uninitKey.toId();
        bytes32 stateSlot = StateLibrary._getPoolStateSlot(uninitId);
        vm.mockCall(
            address(1),
            abi.encodeWithSignature("extsload(bytes32)", stateSlot),
            abi.encode(bytes32(0))
        );

        vm.prank(trader);
        vm.expectRevert(HazeHook.PoolNotInitialized.selector);
        hook.commitSwap{value: bond}(uninitKey, true, -1e18, block.timestamp + 1 days);
    }

    function testDirectionalCandidatePriceRejectsOutOfRangeIndex() public {
        // Compute the out-of-range index BEFORE arming expectRevert: it's a
        // staticcall in its own right, and expectRevert only covers the very
        // next call — evaluating it inline as an argument would consume the
        // expectation on that (non-reverting) call instead of the real one.
        uint8 outOfRangeIndex = hook.NUM_CANDIDATES();
        vm.expectRevert("Invalid candidate");
        hook.directionalCandidatePrice(1e18, outOfRangeIndex, true);
    }

    function testRecommendedSlippageTracksImpactAndCapsAt500() public view {
        // Mocked pool: 1e9 liquidity. A moderate exact-input amount produces a
        // real, sub-cap impact — recommendation should be impact + 5bps.
        uint256 impact = hook.estimatedImpactBps(key, true, -1e17);
        uint256 recommended = hook.recommendedSlippageBps(key, true, -1e17);
        assertEq(recommended, impact + 5);

        // A very large amount against the same shallow liquidity blows past the
        // 500bps cap.
        uint256 recommendedHuge = hook.recommendedSlippageBps(key, true, -1e21);
        assertEq(recommendedHuge, 500);
    }

    function testCandidatePricesStayWithinBand() public view {
        uint160 base = 1e18;
        // Widest possible distance is the last candidate: PRICE_BAND_BPS split
        // NUM_CANDIDATES ways, all NUM_CANDIDATES of them. Derived from the
        // constants rather than hardcoded so this doesn't silently stop
        // testing the real invariant if PRICE_BAND_BPS changes again.
        uint256 maxDistance = hook.NUM_CANDIDATES() * hook.PRICE_BAND_BPS() / hook.NUM_CANDIDATES();
        uint160 minDown = uint160(uint256(base) * (10_000 - maxDistance) / 10_000);
        uint160 maxUp = uint160(uint256(base) * (10_000 + maxDistance) / 10_000);

        for (uint8 i = 0; i < hook.NUM_CANDIDATES(); i++) {
            uint160 downPrice = hook.directionalCandidatePrice(base, i, true);
            assertLe(downPrice, base);
            assertGe(downPrice, minDown);

            uint160 upPrice = hook.directionalCandidatePrice(base, i, false);
            assertGe(upPrice, base);
            assertLe(upPrice, maxUp);
        }
    }
}

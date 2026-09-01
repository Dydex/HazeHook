// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {VRFConsumer} from "../src/VRFConsumer.sol";
import {VRFCoordinatorV2_5Mock} from
    "../lib/chainlink-brownie-contracts/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";
import {VRFConsumerBaseV2Plus} from
    "../lib/chainlink-brownie-contracts/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";

/// @notice Unit tests for VRFConsumer against a real Chainlink VRF v2.5 mock
///         coordinator, exercising the actual request/fulfill wiring instead of
///         the fake ISwapRandomnessConsumer doubles used by HazeHook's own tests.
contract VRFConsumerTest is Test {
    VRFCoordinatorV2_5Mock coordinator;
    VRFConsumer consumer;
    uint256 subId;
    bytes32 constant KEY_HASH = keccak256("test-keyhash");

    address hook = address(0xF00D);
    address stranger = address(0xBAD);

    function setUp() public {
        // Base fee / gas price / wei-per-unit-link mirror Chainlink's own sample
        // values for this mock; only relevant for the (untested-here) LINK
        // accounting, not the randomness plumbing this suite cares about.
        coordinator = new VRFCoordinatorV2_5Mock(0.1 ether, 1e9, 4795050300000000);
        subId = coordinator.createSubscription();
        coordinator.fundSubscription(subId, 100 ether);

        consumer = new VRFConsumer(address(coordinator), subId, KEY_HASH);
        coordinator.addConsumer(subId, address(consumer));
        consumer.setHook(hook);
    }

    function testOnlyOwnerCanSetHook() public {
        vm.prank(stranger);
        vm.expectRevert("Only callable by owner");
        consumer.setHook(address(0x1234));
    }

    function testSetHookRejectsZeroAddress() public {
        vm.expectRevert(VRFConsumerBaseV2Plus.ZeroAddress.selector);
        consumer.setHook(address(0));
    }

    function testOnlyOwnerCanSetCallbackConfig() public {
        vm.prank(stranger);
        vm.expectRevert("Only callable by owner");
        consumer.setCallbackConfig(10, 300_000);
    }

    function testOwnerCanSetCallbackConfig() public {
        consumer.setCallbackConfig(10, 300_000);
        assertEq(consumer.requestConfirmations(), 10);
        assertEq(consumer.callbackGasLimit(), 300_000);
    }

    function testOnlyHookCanRequestRandomness() public {
        vm.prank(stranger);
        vm.expectRevert(VRFConsumer.NotHook.selector);
        consumer.requestRandomness(1);
    }

    function testHookCanRequestRandomnessAndTracksRequestId() public {
        vm.prank(hook);
        uint256 requestId = consumer.requestRandomness(42);

        assertEq(consumer.requestForSwap(42), requestId);
        (bool fulfilled, uint8 candidateIndex) = consumer.resultForSwap(42);
        assertFalse(fulfilled);
        assertEq(candidateIndex, 0);
    }

    function testResultForUnknownSwapIsUnfulfilled() public view {
        (bool fulfilled, uint8 candidateIndex) = consumer.resultForSwap(999);
        assertFalse(fulfilled);
        assertEq(candidateIndex, 0);
    }

    function testFulfillmentThroughRealCoordinatorSetsCandidateWithinRange() public {
        vm.prank(hook);
        uint256 requestId = consumer.requestRandomness(7);

        // Drive fulfillment through the real mock coordinator end-to-end (not a
        // direct rawFulfillRandomWords call) so the full request->fulfill round
        // trip via VRFConsumerBaseV2Plus is actually exercised.
        coordinator.fulfillRandomWords(requestId, address(consumer));

        (bool fulfilled, uint8 candidateIndex) = consumer.resultForSwap(7);
        assertTrue(fulfilled);
        assertLt(candidateIndex, consumer.NUM_CANDIDATES());
    }

    function testFulfillmentMapsWordModuloIntoCandidateRange() public {
        vm.prank(hook);
        uint256 requestId = consumer.requestRandomness(7);

        uint256[] memory words = new uint256[](1);
        words[0] = 13; // 13 % NUM_CANDIDATES(5) == 3
        coordinator.fulfillRandomWordsWithOverride(requestId, address(consumer), words);

        (bool fulfilled, uint8 candidateIndex) = consumer.resultForSwap(7);
        assertTrue(fulfilled);
        assertEq(candidateIndex, 3);
    }

    function testOnlyCoordinatorCanCallRawFulfill() public {
        vm.prank(hook);
        uint256 requestId = consumer.requestRandomness(1);

        uint256[] memory words = new uint256[](1);
        words[0] = 1;

        vm.prank(stranger);
        vm.expectRevert();
        consumer.rawFulfillRandomWords(requestId, words);
    }

    function testFulfillingUnknownRequestIdReverts() public {
        uint256[] memory words = new uint256[](1);
        words[0] = 1;

        vm.prank(address(coordinator));
        vm.expectRevert(abi.encodeWithSelector(VRFConsumer.UnknownRequest.selector, 999));
        consumer.rawFulfillRandomWords(999, words);
    }

    function testCannotFulfillSameRequestTwice() public {
        vm.prank(hook);
        uint256 requestId = consumer.requestRandomness(1);

        uint256[] memory words = new uint256[](1);
        words[0] = 1;

        // Go around the mock coordinator's own bookkeeping (which deletes the
        // request after one fulfillment) by calling the raw callback directly as
        // the coordinator, to prove VRFConsumer's OWN idempotency guard —
        // RequestAlreadyFulfilled — is what's actually stopping a replay, not
        // just the mock's request deletion.
        vm.prank(address(coordinator));
        consumer.rawFulfillRandomWords(requestId, words);

        vm.prank(address(coordinator));
        vm.expectRevert(abi.encodeWithSelector(VRFConsumer.RequestAlreadyFulfilled.selector, requestId));
        consumer.rawFulfillRandomWords(requestId, words);
    }

    function testConstructorRejectsZeroCoordinator() public {
        vm.expectRevert(VRFConsumerBaseV2Plus.ZeroAddress.selector);
        new VRFConsumer(address(0), subId, KEY_HASH);
    }
}

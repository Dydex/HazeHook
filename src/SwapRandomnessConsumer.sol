// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

/// @notice Chainlink VRF v2.5 adapter for protected swaps.
/// @dev The callback only records randomness. Pool settlement must happen in a
///      separate user or relayer transaction.
contract SwapRandomnessConsumer is VRFConsumerBaseV2Plus {
    error NotHook();
    error UnknownRequest(uint256 requestId);
    error RequestAlreadyFulfilled(uint256 requestId);

    uint8 public constant NUM_CANDIDATES = 5;
    uint32 public constant NUM_WORDS = 1;

    address public hook;
    uint256 public immutable subscriptionId;
    bytes32 public immutable keyHash;
    uint16 public requestConfirmations = 3;
    uint32 public callbackGasLimit = 150_000;

    struct Result {
        uint256 swapId;
        uint8 candidateIndex;
        bool fulfilled;
        bool exists;
    }

    mapping(uint256 requestId => Result) public results;
    mapping(uint256 swapId => uint256 requestId) public requestForSwap;

    event HookSet(address indexed hook);
    event RandomnessRequested(uint256 indexed swapId, uint256 indexed requestId);
    event RandomnessFulfilled(uint256 indexed swapId, uint256 indexed requestId, uint8 candidateIndex);

    constructor(address coordinator, uint256 subId, bytes32 _keyHash)
        VRFConsumerBaseV2Plus(coordinator)
    {
        if (coordinator == address(0)) revert ZeroAddress();
        subscriptionId = subId;
        keyHash = _keyHash;
    }

    function setHook(address newHook) external onlyOwner {
        if (newHook == address(0)) revert ZeroAddress();
        hook = newHook;
        emit HookSet(newHook);
    }

    function setCallbackConfig(uint16 confirmations, uint32 gasLimit) external onlyOwner {
        requestConfirmations = confirmations;
        callbackGasLimit = gasLimit;
    }

    function requestRandomness(uint256 swapId) external returns (uint256 requestId) {
        if (msg.sender != hook) revert NotHook();

        requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: NUM_WORDS,
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({nativePayment: false})
                )
            })
        );

        results[requestId] = Result({
            swapId: swapId,
            candidateIndex: 0,
            fulfilled: false,
            exists: true
        });
        requestForSwap[swapId] = requestId;
        emit RandomnessRequested(swapId, requestId);
    }

    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        Result storage result = results[requestId];
        if (!result.exists) revert UnknownRequest(requestId);
        if (result.fulfilled) revert RequestAlreadyFulfilled(requestId);

        result.candidateIndex = uint8(randomWords[0] % NUM_CANDIDATES);
        result.fulfilled = true;
        emit RandomnessFulfilled(result.swapId, requestId, result.candidateIndex);
    }

    function resultForSwap(uint256 swapId) external view returns (bool fulfilled, uint8 candidateIndex) {
        Result storage result = results[requestForSwap[swapId]];
        return (result.fulfilled, result.candidateIndex);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";

import {BaseScript} from "../lib/v4-template/script/base/BaseScript.sol";

import {HazeHook, ISwapRandomnessConsumer} from "../src/HazeHook.sol";
import {VRFConsumer} from "../src/VRFConsumer.sol";

/// @notice Deploys a NEW HazeHook (carrying the commit-bond and exact-output
///         fixes) and repoints the EXISTING, already-funded VRFConsumer at it.
/// @dev VRFConsumer.sol's own logic didn't change this session, so it is
///      deliberately reused rather than redeployed — redeploying it would
///      mean re-registering a brand new consumer address with the Chainlink
///      VRF subscription on the dashboard, which is a manual step and not
///      needed here.
contract DeployHookScript is BaseScript {
    address constant EXISTING_VRF_CONSUMER = 0x978ac30c2adF302E86b3815A6d165F2893aF4CE5;

    function run() public {
        VRFConsumer consumer = VRFConsumer(EXISTING_VRF_CONSUMER);

        vm.startBroadcast();

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(poolManager, consumer);
        (address hookAddress, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY, flags, type(HazeHook).creationCode, constructorArgs);

        HazeHook hook = new HazeHook{salt: salt}(poolManager, ISwapRandomnessConsumer(address(consumer)));
        require(address(hook) == hookAddress, "DeployHookScript: Hook Address Mismatch");

        consumer.setHook(address(hook));

        vm.stopBroadcast();

        console2.log("Reused VRFConsumer:", address(consumer));
        console2.log("New HazeHook:", address(hook));
    }
}

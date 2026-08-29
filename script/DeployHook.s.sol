// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";

import {BaseScript} from "../lib/v4-template/script/base/BaseScript.sol";

import {HazeHook, ISwapRandomnessConsumer} from "../src/HazeHook.sol";
import {VRFConsumer} from "../src/VRFConsumer.sol";


contract DeployHookScript is BaseScript {
    address constant SEPOLIA_VRF_COORDINATOR = 0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B;
    bytes32 constant SEPOLIA_KEY_HASH_500GWEI = 0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae;

    function run() public {
        uint256 subscriptionId = vm.envUint("VRF_SUBSCRIPTION_ID");
        address coordinator = vm.envOr("VRF_COORDINATOR", SEPOLIA_VRF_COORDINATOR);
        bytes32 keyHash = vm.envOr("VRF_KEY_HASH", SEPOLIA_KEY_HASH_500GWEI);

        vm.startBroadcast();

        VRFConsumer consumer = new VRFConsumer(coordinator, subscriptionId, keyHash);

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(poolManager, consumer);
        (address hookAddress, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY, flags, type(HazeHook).creationCode, constructorArgs);

        HazeHook hook = new HazeHook{salt: salt}(poolManager, ISwapRandomnessConsumer(address(consumer)));
        require(address(hook) == hookAddress, "DeployHookScript: Hook Address Mismatch");

        consumer.setHook(address(hook));

        vm.stopBroadcast();

        console2.log("VRFConsumer:", address(consumer));
        console2.log("HazeHook:", address(hook));
        console2.log("VRF subscription id:", subscriptionId);
    }
}

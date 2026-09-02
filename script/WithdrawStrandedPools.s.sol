// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";

import {BaseScript} from "../lib/v4-template/script/base/BaseScript.sol";

/// @notice Burns the two LP position NFTs left behind by hook redeploys
///         (V1's original lopsided pool, and the V2 pool that was live for
///         only a few minutes before the auto-refund fix superseded it) and
///         sweeps the reclaimed HTT/WETH back to the deployer, so it can be
///         reused to seed the next pool instead of needing fresh capital.
/// @dev BURN_POSITION auto-decreases liquidity to 0 before burning the NFT
///      (no separate DECREASE_LIQUIDITY action needed), and both positions
///      share the same currency pair (TEST_TOKEN/WETH) despite belonging to
///      different pools (different hook addresses), so a single TAKE_PAIR at
///      the end sweeps both burns' proceeds in one go.
contract WithdrawStrandedPoolsScript is BaseScript {
    address constant TEST_TOKEN = 0xDE8A1613Ee95a0Ee72fF5B72Af2aAdFe6C783F3D;
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;

    // V1 pool position (original lopsided pool, hook 0x47eba0b2...048080)
    uint256 constant TOKEN_ID_V1 = 38702;
    // V2 pool position (superseded within minutes by the auto-refund fix,
    // hook 0x693A5f83...cc080)
    uint256 constant TOKEN_ID_V2 = 38735;

    function run() external {
        vm.startBroadcast();

        bytes memory actions = abi.encodePacked(
            uint8(Actions.BURN_POSITION), uint8(Actions.BURN_POSITION), uint8(Actions.TAKE_PAIR)
        );
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(TOKEN_ID_V1, uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(TOKEN_ID_V2, uint128(0), uint128(0), bytes(""));
        params[2] = abi.encode(Currency.wrap(TEST_TOKEN), Currency.wrap(WETH), deployerAddress);

        uint256 httBefore = IERC20(TEST_TOKEN).balanceOf(deployerAddress);
        uint256 wethBefore = IERC20(WETH).balanceOf(deployerAddress);

        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp + 3600);

        vm.stopBroadcast();

        console2.log("HTT reclaimed:", IERC20(TEST_TOKEN).balanceOf(deployerAddress) - httBefore);
        console2.log("WETH reclaimed:", IERC20(WETH).balanceOf(deployerAddress) - wethBefore);
    }
}

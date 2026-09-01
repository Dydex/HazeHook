import { useEffect, useState } from "react";
import { encodeAbiParameters, parseUnits } from "viem";
import { useAccount, useReadContract, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import {
  ACTIONS,
  ERC20_ABI,
  EXTSLOAD_ABI,
  estimateLiquidityForAmounts,
  LP_TICK_LOWER,
  LP_TICK_UPPER,
  PERMIT2_ABI,
  PERMIT2_ADDRESS,
  POOL_KEY,
  POOL_MANAGER_ADDRESS,
  POSITION_MANAGER_ABI,
  POSITION_MANAGER_ADDRESS,
  TEST_TOKEN_ADDRESS,
  WETH_ADDRESS,
  explorerTxLink,
  poolStateSlot,
  tickFromSlot0,
} from "@/lib/contracts";

const MAX_UINT160 = (BigInt(1) << BigInt(160)) - BigInt(1);
const MAX_UINT48 = 281474976710655; // 2^48 - 1, Permit2's expiration field width

export function AddLiquidityForm() {
  const { address } = useAccount();

  const [httAmount, setHttAmount] = useState("100");
  const [wethAmount, setWethAmount] = useState("0.01");
  const [done, setDone] = useState(false);

  const httDesired = safeParseUnits(httAmount);
  const wethDesired = safeParseUnits(wethAmount);

  const { data: slot0 } = useReadContract({
    address: POOL_MANAGER_ADDRESS,
    abi: EXTSLOAD_ABI,
    functionName: "extsload",
    args: [poolStateSlot()],
  });

  const { data: allowances, refetch: refetchAllowances } = useReadContracts({
    contracts: address
      ? [
          { address: TEST_TOKEN_ADDRESS, abi: ERC20_ABI, functionName: "allowance", args: [address, PERMIT2_ADDRESS] },
          { address: WETH_ADDRESS, abi: ERC20_ABI, functionName: "allowance", args: [address, PERMIT2_ADDRESS] },
          { address: PERMIT2_ADDRESS, abi: PERMIT2_ABI, functionName: "allowance", args: [address, TEST_TOKEN_ADDRESS, POSITION_MANAGER_ADDRESS] },
          { address: PERMIT2_ADDRESS, abi: PERMIT2_ABI, functionName: "allowance", args: [address, WETH_ADDRESS, POSITION_MANAGER_ADDRESS] },
        ]
      : [],
    query: { enabled: !!address },
  });

  const httErc20Allowance = allowances?.[0]?.result as bigint | undefined;
  const wethErc20Allowance = allowances?.[1]?.result as bigint | undefined;
  const httPermit2Allowance = allowances?.[2]?.result as readonly [bigint, number, number] | undefined;
  const wethPermit2Allowance = allowances?.[3]?.result as readonly [bigint, number, number] | undefined;

  const needsHttErc20 = httDesired !== undefined && (httErc20Allowance ?? BigInt(0)) < httDesired;
  const needsWethErc20 = wethDesired !== undefined && (wethErc20Allowance ?? BigInt(0)) < wethDesired;
  const needsHttPermit2 = httDesired !== undefined && (httPermit2Allowance?.[0] ?? BigInt(0)) < httDesired;
  const needsWethPermit2 = wethDesired !== undefined && (wethPermit2Allowance?.[0] ?? BigInt(0)) < wethDesired;

  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data });
  useEffect(() => {
    if (receipt.isSuccess) refetchAllowances();
  }, [receipt.isSuccess, refetchAllowances]);

  function approveErc20(token: `0x${string}`) {
    write.writeContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [PERMIT2_ADDRESS, MAX_UINT160] });
  }

  function approvePermit2(token: `0x${string}`) {
    write.writeContract({
      address: PERMIT2_ADDRESS,
      abi: PERMIT2_ABI,
      functionName: "approve",
      args: [token, POSITION_MANAGER_ADDRESS, MAX_UINT160, MAX_UINT48],
    });
  }

  function addLiquidity() {
    if (!address || httDesired === undefined || wethDesired === undefined || !slot0) return;
    const currentTick = tickFromSlot0(slot0);
    const liquidityEstimate = estimateLiquidityForAmounts(
      currentTick,
      Number(httAmount),
      Number(wethAmount),
    );
    const liquidity = BigInt(Math.max(1, Math.floor(liquidityEstimate)));

    const hookData = "0x" as const;
    const actions = concatActions([ACTIONS.MINT_POSITION, ACTIONS.SETTLE_PAIR, ACTIONS.SWEEP, ACTIONS.SWEEP]);
    const mintParams = encodeMintParams(POOL_KEY, LP_TICK_LOWER, LP_TICK_UPPER, liquidity, httDesired, wethDesired, address, hookData);
    const settlePairParams = encodeSettlePair(POOL_KEY.currency0, POOL_KEY.currency1);
    const sweepHtt = encodeSweep(POOL_KEY.currency0, address);
    const sweepWeth = encodeSweep(POOL_KEY.currency1, address);

    write.writeContract({
      address: POSITION_MANAGER_ADDRESS,
      abi: POSITION_MANAGER_ABI,
      functionName: "modifyLiquidities",
      args: [encodeUnlockData(actions, [mintParams, settlePairParams, sweepHtt, sweepWeth]), BigInt(Math.floor(Date.now() / 1000) + 3600)],
    });
    setDone(false);
  }

  useEffect(() => {
    if (receipt.isSuccess && write.variables?.functionName === "modifyLiquidities") setDone(true);
  }, [receipt.isSuccess, write.variables]);

  let label = "Enter amounts";
  let disabled = true;
  let onClick = () => {};
  if (!address) {
    label = "Connect wallet";
  } else if (httDesired === undefined || wethDesired === undefined || (httDesired === BigInt(0) && wethDesired === BigInt(0))) {
    label = "Enter amounts";
  } else if (needsHttErc20) {
    label = write.isPending || receipt.isLoading ? "Approving…" : "Approve HTT";
    disabled = write.isPending || receipt.isLoading;
    onClick = () => approveErc20(TEST_TOKEN_ADDRESS);
  } else if (needsWethErc20) {
    label = write.isPending || receipt.isLoading ? "Approving…" : "Approve WETH";
    disabled = write.isPending || receipt.isLoading;
    onClick = () => approveErc20(WETH_ADDRESS);
  } else if (needsHttPermit2) {
    label = write.isPending || receipt.isLoading ? "Approving…" : "Approve HTT (Permit2)";
    disabled = write.isPending || receipt.isLoading;
    onClick = () => approvePermit2(TEST_TOKEN_ADDRESS);
  } else if (needsWethPermit2) {
    label = write.isPending || receipt.isLoading ? "Approving…" : "Approve WETH (Permit2)";
    disabled = write.isPending || receipt.isLoading;
    onClick = () => approvePermit2(WETH_ADDRESS);
  } else {
    label = write.isPending || receipt.isLoading ? "Adding liquidity…" : "Add liquidity";
    disabled = write.isPending || receipt.isLoading;
    onClick = addLiquidity;
  }

  return (
    <div className="rounded-2xl border border-white/[.08] bg-white/[.02] p-5">
      <span className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">Add liquidity</span>
      <p className="mt-1 text-[11px] text-zinc-500">
        Deposits into the existing pool&apos;s position range. Four approvals the first time (ERC20 → Permit2 → PositionManager,
        for each token), one each time after.
      </p>

      <div className="mt-4 flex flex-col gap-3">
        <div className="rounded-xl border border-white/[.08] bg-black/40 p-3">
          <div className="mb-1 text-[11px] uppercase tracking-widest text-zinc-500">HTT amount</div>
          <input
            type="number"
            min="0"
            step="any"
            value={httAmount}
            onChange={(e) => setHttAmount(e.target.value)}
            className="w-full bg-transparent font-mono text-lg font-semibold text-zinc-100 outline-none"
          />
        </div>
        <div className="rounded-xl border border-white/[.08] bg-black/40 p-3">
          <div className="mb-1 text-[11px] uppercase tracking-widest text-zinc-500">WETH amount</div>
          <input
            type="number"
            min="0"
            step="any"
            value={wethAmount}
            onChange={(e) => setWethAmount(e.target.value)}
            className="w-full bg-transparent font-mono text-lg font-semibold text-zinc-100 outline-none"
          />
        </div>
      </div>

      <button
        onClick={onClick}
        disabled={disabled}
        className="mt-4 flex h-11 w-full items-center justify-center rounded-xl bg-zinc-100 font-mono text-xs font-bold uppercase tracking-widest text-black transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-white/[.08] disabled:text-zinc-500"
      >
        {label}
      </button>

      {write.error && <p className="mt-2 font-mono text-xs text-red-400">{write.error.message.split("\n")[0]}</p>}

      {done && receipt.data && (
        <a
          href={explorerTxLink(receipt.data.transactionHash)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 block font-mono text-xs text-zinc-500 underline hover:text-zinc-300"
        >
          Liquidity added — view on Etherscan ↗
        </a>
      )}
    </div>
  );
}

function safeParseUnits(value: string): bigint | undefined {
  try {
    return value ? parseUnits(value, 18) : undefined;
  } catch {
    return undefined;
  }
}

// --- PositionManager calldata encoding (mirrors LiquidityHelpers._mintLiquidityParams) ---

function concatActions(actions: number[]): `0x${string}` {
  return `0x${actions.map((a) => a.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

function encodeMintParams(
  poolKey: typeof POOL_KEY,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
  amount0Max: bigint,
  amount1Max: bigint,
  recipient: `0x${string}`,
  hookData: `0x${string}`,
): `0x${string}` {
  return encodeAbiParameters(
    [
      { type: "tuple", components: [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }] },
      { type: "int24" },
      { type: "int24" },
      { type: "uint256" },
      { type: "uint128" },
      { type: "uint128" },
      { type: "address" },
      { type: "bytes" },
    ],
    [
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      tickLower,
      tickUpper,
      liquidity,
      amount0Max + BigInt(1),
      amount1Max + BigInt(1),
      recipient,
      hookData,
    ],
  );
}

function encodeSettlePair(currency0: `0x${string}`, currency1: `0x${string}`): `0x${string}` {
  return encodeAbiParameters([{ type: "address" }, { type: "address" }], [currency0, currency1]);
}

function encodeSweep(currency: `0x${string}`, recipient: `0x${string}`): `0x${string}` {
  return encodeAbiParameters([{ type: "address" }, { type: "address" }], [currency, recipient]);
}

function encodeUnlockData(actions: `0x${string}`, params: `0x${string}`[]): `0x${string}` {
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, params]);
}

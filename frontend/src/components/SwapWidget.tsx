import { useEffect, useState } from "react";
import { decodeEventLog, encodeFunctionData, formatEther, formatUnits, parseUnits } from "viem";
import {
  useAccount,
  useEstimateGas,
  useGasPrice,
  useReadContract,
  useReadContracts,
  useSimulateContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import {
  ERC20_ABI,
  EXTSLOAD_ABI,
  HAZE_HOOK_ABI,
  HAZE_HOOK_ADDRESS,
  HOOK_PARAMS,
  POOL_KEY,
  POOL_MANAGER_ADDRESS,
  TEST_TOKEN_ADDRESS,
  V4_QUOTER_ABI,
  V4_QUOTER_ADDRESS,
  V4_ROUTER_ABI,
  V4_ROUTER_ADDRESS,
  VRF_CONSUMER_ABI,
  VRF_CONSUMER_ADDRESS,
  WETH_ADDRESS,
  explorerTxLink,
  poolStateSlot,
  sqrtPriceX96FromSlot0,
} from "@/lib/contracts";

const DEADLINE_SECONDS = 30 * 60; // 30 minutes from commit
const PERCENTAGES = [25, 50, 75, 100];

function TokenPill({ symbol, color }: { symbol: string; color: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/[.12] bg-white/[.04] px-3 py-1.5 font-mono text-xs font-bold uppercase text-zinc-100">
      <span className={`h-2.5 w-2.5 rounded-full ${color}`} />
      {symbol}
    </span>
  );
}

export function SwapWidget() {
  const { address } = useAccount();

  const [amount, setAmount] = useState("60");
  const [zeroForOne, setZeroForOne] = useState(true);
  const [submittedAmount, setSubmittedAmount] = useState<string | null>("60");
  const [swapId, setSwapId] = useState<bigint | null>(null);
  const [settled, setSettled] = useState(false);
  const [commitDeadline, setCommitDeadline] = useState<bigint | null>(null);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const [rateFlipped, setRateFlipped] = useState(false);

  const amountSpecified = submittedAmount ? -parseUnits(submittedAmount || "0", 18) : undefined;
  const inputToken = zeroForOne ? TEST_TOKEN_ADDRESS : WETH_ADDRESS;
  const inputSymbol = zeroForOne ? "HTT" : "WETH";
  const outputSymbol = zeroForOne ? "WETH" : "HTT";

  function flip() {
    if (swapId !== null) return; // don't let direction change mid-commit
    setZeroForOne((z) => !z);
    setSubmittedAmount(null);
  }

  // --- Balance of the current input token ---
  const { data: inputBalance, refetch: refetchInputBalance } = useReadContract({
    address: inputToken,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });
  const currentBalance = inputBalance as bigint | undefined;

  function setPercentage(pct: number) {
    if (currentBalance === undefined) return;
    const value = (currentBalance * BigInt(pct)) / BigInt(100);
    setAmount(formatUnits(value, 18));
  }

  let parsedAmount: bigint | undefined;
  try {
    parsedAmount = amount ? parseUnits(amount, 18) : undefined;
  } catch {
    parsedAmount = undefined;
  }
  const insufficientBalance =
    !!address && parsedAmount !== undefined && currentBalance !== undefined && parsedAmount > currentBalance;

  // --- Live pool price (HTT is currency0, WETH is currency1 — both 18 decimals) ---
  const { data: slot0 } = useReadContract({
    address: POOL_MANAGER_ADDRESS,
    abi: EXTSLOAD_ABI,
    functionName: "extsload",
    args: [poolStateSlot()],
    query: { refetchInterval: 15_000 },
  });
  let rateText = "Loading rate…";
  if (slot0) {
    const sqrtPriceX96 = sqrtPriceX96FromSlot0(slot0);
    const wethPerHtt = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
    rateText = rateFlipped
      ? `1 WETH = ${(1 / wethPerHtt).toFixed(4)} HTT`
      : `1 HTT = ${wethPerHtt.toFixed(4)} WETH`;
  }

  const { data, isFetching, error } = useReadContracts({
    contracts:
      amountSpecified === undefined
        ? []
        : [
            { address: HAZE_HOOK_ADDRESS, abi: HAZE_HOOK_ABI, functionName: "estimatedImpactBps", args: [POOL_KEY, zeroForOne, amountSpecified] },
            { address: HAZE_HOOK_ADDRESS, abi: HAZE_HOOK_ABI, functionName: "isProtected", args: [POOL_KEY, zeroForOne, amountSpecified] },
            { address: HAZE_HOOK_ADDRESS, abi: HAZE_HOOK_ABI, functionName: "recommendedSlippageBps", args: [POOL_KEY, zeroForOne, amountSpecified] },
          ],
    query: { enabled: amountSpecified !== undefined },
  });

  const impactBps = data?.[0]?.result as bigint | undefined;
  const isProtected = data?.[1]?.result as boolean | undefined;
  const recommendedSlippageBps = data?.[2]?.result as bigint | undefined;

  // --- Expected output — only resolvable for fast-lane amounts. The Quoter
  // simulates a real swap through the pool, which goes through HazeHook's
  // _beforeSwap too, so it reverts for protected-lane amounts exactly like a
  // real swap would (there's no exact output to quote until VRF settles).
  const { data: quote, isFetching: isQuoting } = useSimulateContract({
    address: V4_QUOTER_ADDRESS,
    abi: V4_QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args:
      amountSpecified !== undefined
        ? [{ poolKey: POOL_KEY, zeroForOne, exactAmount: -amountSpecified, hookData: "0x" }]
        : undefined,
    query: { enabled: amountSpecified !== undefined && isProtected === false },
  });
  const expectedOut = quote?.result?.[0];

  const needsRecheck = submittedAmount !== amount;

  function checkRisk() {
    setSubmittedAmount(amount);
    setSwapId(null);
    setSettled(false);
    setCommitDeadline(null);
  }

  // Ticks once a second while a commit is outstanding, so the expiry/cancel
  // state updates live without needing an on-chain read to trigger it.
  useEffect(() => {
    if (swapId === null || settled) return;
    const id = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [swapId, settled]);

  // --- Approval ---
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: inputToken,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, HAZE_HOOK_ADDRESS] : undefined,
    query: { enabled: !!address && isProtected === true },
  });

  const currentAllowance = allowance as bigint | undefined;
  const needsApproval =
    isProtected === true &&
    amountSpecified !== undefined &&
    (currentAllowance === undefined || currentAllowance < -amountSpecified);

  const approve = useWriteContract();
  const approveReceipt = useWaitForTransactionReceipt({ hash: approve.data });
  useEffect(() => {
    if (approveReceipt.isSuccess) refetchAllowance();
  }, [approveReceipt.isSuccess, refetchAllowance]);

  function doApprove() {
    approve.writeContract({
      address: inputToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [HAZE_HOOK_ADDRESS, amountSpecified !== undefined ? -amountSpecified : BigInt(0)],
    });
  }

  // --- Fast-lane execution (real swap via Sepolia's V4 router) ---
  const { data: routerAllowance, refetch: refetchRouterAllowance } = useReadContract({
    address: inputToken,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, V4_ROUTER_ADDRESS] : undefined,
    query: { enabled: !!address && isProtected === false },
  });
  const currentRouterAllowance = routerAllowance as bigint | undefined;
  const needsRouterApproval =
    isProtected === false &&
    amountSpecified !== undefined &&
    (currentRouterAllowance === undefined || currentRouterAllowance < -amountSpecified);

  const fastApprove = useWriteContract();
  const fastApproveReceipt = useWaitForTransactionReceipt({ hash: fastApprove.data });
  useEffect(() => {
    if (fastApproveReceipt.isSuccess) refetchRouterAllowance();
  }, [fastApproveReceipt.isSuccess, refetchRouterAllowance]);

  function doFastApprove() {
    fastApprove.writeContract({
      address: inputToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [V4_ROUTER_ADDRESS, amountSpecified !== undefined ? -amountSpecified : BigInt(0)],
    });
  }

  const fastSwap = useWriteContract();
  const fastSwapReceipt = useWaitForTransactionReceipt({ hash: fastSwap.data });
  useEffect(() => {
    if (fastSwapReceipt.isSuccess) refetchInputBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fastSwapReceipt.isSuccess]);

  function doFastSwap() {
    if (amountSpecified === undefined || !address) return;
    const amountIn = -amountSpecified;
    // Use the hook's own recommended slippage against the Quoter's exact
    // quote for a real minimum-out — not zero, not a guess.
    const amountOutMin =
      expectedOut !== undefined && recommendedSlippageBps !== undefined
        ? expectedOut - (expectedOut * recommendedSlippageBps) / BigInt(10_000)
        : BigInt(0);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
    fastSwap.writeContract({
      address: V4_ROUTER_ADDRESS,
      abi: V4_ROUTER_ABI,
      functionName: "swapExactTokensForTokens",
      args: [amountIn, amountOutMin, zeroForOne, POOL_KEY, "0x", address, deadline],
    });
  }

  function resetFast() {
    fastSwap.reset();
    fastApprove.reset();
    setSubmittedAmount(null);
  }

  // --- Commit ---
  const commit = useWriteContract();
  const commitReceipt = useWaitForTransactionReceipt({ hash: commit.data });

  useEffect(() => {
    if (!commitReceipt.data) return;
    for (const log of commitReceipt.data.logs) {
      try {
        const decoded = decodeEventLog({ abi: HAZE_HOOK_ABI, data: log.data, topics: log.topics });
        if (decoded.eventName === "SwapCommitted") {
          setSwapId(decoded.args.swapId);
          break;
        }
      } catch {
        // not our event, ignore
      }
    }
  }, [commitReceipt.data]);

  function doCommit() {
    if (amountSpecified === undefined) return;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
    setCommitDeadline(deadline);
    commit.writeContract({
      address: HAZE_HOOK_ADDRESS,
      abi: HAZE_HOOK_ABI,
      functionName: "commitSwap",
      args: [POOL_KEY, zeroForOne, amountSpecified, deadline],
    });
  }

  const isExpired = commitDeadline !== null && nowSeconds >= Number(commitDeadline);
  const secondsRemaining = commitDeadline !== null ? Number(commitDeadline) - nowSeconds : null;

  // --- VRF status ---
  const { data: vrfResult } = useReadContract({
    address: VRF_CONSUMER_ADDRESS,
    abi: VRF_CONSUMER_ABI,
    functionName: "resultForSwap",
    args: swapId !== null ? [swapId] : undefined,
    query: { enabled: swapId !== null && !settled, refetchInterval: 5000 },
  });
  const fulfilled = vrfResult?.[0] ?? false;

  // --- Settle ---
  const settle = useWriteContract();
  const settleReceipt = useWaitForTransactionReceipt({ hash: settle.data });
  useEffect(() => {
    if (settleReceipt.isSuccess) {
      setSettled(true);
      refetchInputBalance();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settleReceipt.isSuccess]);

  function doSettle() {
    if (swapId === null) return;
    settle.writeContract({
      address: HAZE_HOOK_ADDRESS,
      abi: HAZE_HOOK_ABI,
      functionName: "settleSwap",
      args: [swapId],
    });
  }

  // --- Cancel (only possible once the commit deadline has passed) ---
  const cancel = useWriteContract();
  const cancelReceipt = useWaitForTransactionReceipt({ hash: cancel.data });
  useEffect(() => {
    if (cancelReceipt.isSuccess) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelReceipt.isSuccess]);

  function doCancel() {
    if (swapId === null) return;
    cancel.writeContract({
      address: HAZE_HOOK_ADDRESS,
      abi: HAZE_HOOK_ABI,
      functionName: "cancelExpiredSwap",
      args: [swapId],
    });
  }

  function reset() {
    setSwapId(null);
    setSettled(false);
    setCommitDeadline(null);
  }

  // --- Gas estimate for whichever transaction is next in the flow ---
  let nextAction: { to: `0x${string}`; data: `0x${string}` } | undefined;
  if (isProtected === false && needsRouterApproval && amountSpecified !== undefined) {
    nextAction = {
      to: inputToken,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [V4_ROUTER_ADDRESS, -amountSpecified] }),
    };
  } else if (
    isProtected === false &&
    !needsRouterApproval &&
    !fastSwapReceipt.isSuccess &&
    amountSpecified !== undefined &&
    address
  ) {
    const amountIn = -amountSpecified;
    const amountOutMin =
      expectedOut !== undefined && recommendedSlippageBps !== undefined
        ? expectedOut - (expectedOut * recommendedSlippageBps) / BigInt(10_000)
        : BigInt(0);
    nextAction = {
      to: V4_ROUTER_ADDRESS,
      data: encodeFunctionData({
        abi: V4_ROUTER_ABI,
        functionName: "swapExactTokensForTokens",
        args: [
          amountIn,
          amountOutMin,
          zeroForOne,
          POOL_KEY,
          "0x",
          address,
          BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS),
        ],
      }),
    };
  } else if (needsApproval && amountSpecified !== undefined) {
    nextAction = {
      to: inputToken,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [HAZE_HOOK_ADDRESS, -amountSpecified] }),
    };
  } else if (isProtected && swapId === null && amountSpecified !== undefined && !needsApproval) {
    nextAction = {
      to: HAZE_HOOK_ADDRESS,
      data: encodeFunctionData({
        abi: HAZE_HOOK_ABI,
        functionName: "commitSwap",
        args: [POOL_KEY, zeroForOne, amountSpecified, BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS)],
      }),
    };
  } else if (swapId !== null && !settled && isExpired && !fulfilled) {
    nextAction = {
      to: HAZE_HOOK_ADDRESS,
      data: encodeFunctionData({ abi: HAZE_HOOK_ABI, functionName: "cancelExpiredSwap", args: [swapId] }),
    };
  } else if (swapId !== null && !settled && fulfilled) {
    nextAction = {
      to: HAZE_HOOK_ADDRESS,
      data: encodeFunctionData({ abi: HAZE_HOOK_ABI, functionName: "settleSwap", args: [swapId] }),
    };
  }

  const gasEstimate = useEstimateGas({
    account: address,
    to: nextAction?.to,
    data: nextAction?.data,
    query: { enabled: !!address && !!nextAction },
  });
  const { data: gasPrice } = useGasPrice();
  const estimatedFeeWei = gasEstimate.data && gasPrice ? gasEstimate.data * gasPrice : undefined;

  // --- Single primary action button, Uniswap-style ---
  let primaryLabel = "Enter an amount";
  let primaryDisabled = true;
  let primaryOnClick = () => {};
  if (!amount || parsedAmount === undefined || parsedAmount === BigInt(0)) {
    primaryLabel = "Enter an amount";
  } else if (insufficientBalance) {
    primaryLabel = `Insufficient ${inputSymbol} balance`;
  } else if (needsRecheck || impactBps === undefined) {
    primaryLabel = isFetching ? "Checking…" : "Check risk";
    primaryDisabled = isFetching;
    primaryOnClick = checkRisk;
  } else if (!isProtected) {
    if (!address) {
      primaryLabel = "Connect wallet to swap";
    } else if (fastSwapReceipt.isSuccess) {
      primaryLabel = "Swap complete";
    } else if (needsRouterApproval) {
      primaryLabel = fastApprove.isPending || fastApproveReceipt.isLoading ? "Approving…" : `Approve ${inputSymbol}`;
      primaryDisabled = fastApprove.isPending || fastApproveReceipt.isLoading;
      primaryOnClick = doFastApprove;
    } else {
      primaryLabel = fastSwap.isPending || fastSwapReceipt.isLoading ? "Swapping…" : "Swap";
      primaryDisabled = fastSwap.isPending || fastSwapReceipt.isLoading;
      primaryOnClick = doFastSwap;
    }
  } else if (!address) {
    primaryLabel = "Connect wallet to continue";
  } else if (settled) {
    primaryLabel = "Swap settled";
  } else if (swapId === null) {
    if (needsApproval) {
      primaryLabel = approve.isPending || approveReceipt.isLoading ? "Approving…" : `Approve ${inputSymbol}`;
      primaryDisabled = approve.isPending || approveReceipt.isLoading;
      primaryOnClick = doApprove;
    } else {
      primaryLabel = commit.isPending || commitReceipt.isLoading ? "Committing…" : "Commit swap";
      primaryDisabled = commit.isPending || commitReceipt.isLoading;
      primaryOnClick = doCommit;
    }
  } else if (!fulfilled) {
    primaryLabel = isExpired ? "Swap expired — waiting on you to cancel" : "Waiting on Chainlink VRF…";
    primaryDisabled = true;
  } else {
    primaryLabel = settle.isPending || settleReceipt.isLoading ? "Settling…" : "Settle swap";
    primaryDisabled = settle.isPending || settleReceipt.isLoading;
    primaryOnClick = doSettle;
  }

  const buyDisplay =
    needsRecheck || amountSpecified === undefined
      ? "0.0"
      : isProtected
        ? "—"
        : isQuoting
          ? "…"
          : expectedOut !== undefined
            ? Number(formatUnits(expectedOut, 18)).toFixed(6)
            : "—";

  return (
    <div className="w-full rounded-2xl border border-white/[.08] bg-white/[.02] p-5 shadow-2xl shadow-black/40">
      <div className="mb-4 flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">Swap</span>
        <span className="flex items-center gap-1.5 rounded-full border border-violet-500/40 bg-violet-500/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-violet-300">
          <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
          Live preview
        </span>
      </div>

      {/* Sell */}
      <div className="rounded-xl border border-white/[.08] bg-black/40 p-4">
        <div className="mb-2 text-[11px] uppercase tracking-widest text-zinc-500">Sell</div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min="0"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={swapId !== null}
            className="w-full bg-transparent font-mono text-2xl font-semibold text-zinc-100 outline-none disabled:opacity-50"
            placeholder="0.0"
          />
          <TokenPill symbol={inputSymbol} color={zeroForOne ? "bg-lime-400" : "bg-cyan-400"} />
        </div>
        <div className="mt-2 flex items-center justify-between font-mono text-[11px]">
          <span className={insufficientBalance ? "text-red-400" : "text-transparent"}>Insufficient balance</span>
          {address && currentBalance !== undefined && (
            <span className="text-zinc-500">
              Balance: {Number(formatUnits(currentBalance, 18)).toFixed(4)} {inputSymbol}
            </span>
          )}
        </div>

        {address && (
          <div className="mt-3 flex gap-1.5">
            {PERCENTAGES.map((pct) => (
              <button
                key={pct}
                onClick={() => setPercentage(pct)}
                disabled={swapId !== null || currentBalance === undefined}
                className="flex-1 rounded-md border border-white/[.12] py-1 font-mono text-[11px] font-bold uppercase text-zinc-400 transition-colors hover:border-violet-400/40 hover:text-violet-300 disabled:opacity-40"
              >
                {pct === 100 ? "MAX" : `${pct}%`}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Flip */}
      <div className="relative z-10 -my-3 flex justify-center">
        <button
          onClick={flip}
          disabled={swapId !== null}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-white/[.12] bg-[#111116] text-zinc-400 transition-colors hover:text-zinc-100 disabled:opacity-40"
          aria-label="Flip direction"
        >
          ↓
        </button>
      </div>

      {/* Buy */}
      <div className="rounded-xl border border-white/[.08] bg-black/40 p-4">
        <div className="mb-2 text-[11px] uppercase tracking-widest text-zinc-500">Buy</div>
        <div className="flex items-center gap-2">
          <span className="w-full truncate font-mono text-2xl font-semibold text-zinc-100">{buyDisplay}</span>
          <TokenPill symbol={outputSymbol} color={zeroForOne ? "bg-cyan-400" : "bg-lime-400"} />
        </div>
        <div className="mt-2 font-mono text-[11px] text-zinc-500">
          {!needsRecheck && isProtected
            ? "Not known until settlement — bounded by a VRF draw"
            : " "}
        </div>
      </div>

      {/* Rate + gas */}
      <div className="mt-3 flex items-center justify-between font-mono text-[11px] text-zinc-500">
        <button onClick={() => setRateFlipped((f) => !f)} className="flex items-center gap-1 hover:text-zinc-300">
          {rateText} <span className="text-zinc-600">⇄</span>
        </button>
        {estimatedFeeWei !== undefined && (
          <span className="flex items-center gap-1">⛽ {Number(formatEther(estimatedFeeWei)).toFixed(6)} ETH</span>
        )}
      </div>

      {/* Primary action */}
      <button
        onClick={primaryOnClick}
        disabled={primaryDisabled}
        className="mt-3 flex h-11 w-full items-center justify-center rounded-xl bg-zinc-100 font-mono text-xs font-bold uppercase tracking-widest text-black transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-white/[.08] disabled:text-zinc-500"
      >
        {primaryLabel}
      </button>

      {error && (
        <p className="mt-3 font-mono text-xs text-red-400">Couldn&apos;t read the pool — try a different amount.</p>
      )}

      {/* Details */}
      {!needsRecheck && impactBps !== undefined && isProtected !== undefined && recommendedSlippageBps !== undefined && (
        <div className="mt-4 flex flex-col gap-2 rounded-xl border border-white/[.08] bg-black/40 p-4 font-mono text-xs">
          <div className="flex justify-between text-zinc-400">
            <span>Price impact</span>
            <span className="text-zinc-100">{Number(impactBps) / 100}%</span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>Recommended slippage</span>
            <span className="text-zinc-100">{Number(recommendedSlippageBps) / 100}%</span>
          </div>
          <div
            className={`mt-1 flex items-center gap-2 rounded-lg border px-3 py-2 uppercase tracking-widest ${
              isProtected
                ? "border-pink-500/40 bg-pink-500/10 text-pink-300"
                : "border-cyan-400/40 bg-cyan-400/10 text-cyan-300"
            }`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {isProtected ? "Protected lane — commit/settle" : "Fast lane — executes instantly"}
          </div>

          {isProtected === false && (
            <div className="mt-1 flex flex-col gap-2">
              {(fastApprove.error || fastSwap.error) && (
                <p className="text-red-400">{(fastApprove.error ?? fastSwap.error)?.message.split("\n")[0]}</p>
              )}
              {fastSwapReceipt.isSuccess && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 rounded-lg border border-lime-400/40 bg-lime-400/10 px-3 py-2 text-lime-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                    Swap complete
                  </div>
                  {fastSwapReceipt.data && (
                    <a
                      href={explorerTxLink(fastSwapReceipt.data.transactionHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-500 underline hover:text-zinc-300"
                    >
                      View on Etherscan ↗
                    </a>
                  )}
                  <button
                    onClick={resetFast}
                    className="mt-1 flex h-9 items-center justify-center rounded-lg border border-white/[.12] font-mono text-xs uppercase tracking-widest text-zinc-300 hover:bg-white/[.06]"
                  >
                    Start another swap
                  </button>
                </div>
              )}
            </div>
          )}

          {isProtected && swapId !== null && !settled && (
            <div className="mt-1 flex flex-col gap-2">
              {!fulfilled && (
                <div className="flex items-center gap-2 rounded-lg border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-violet-300">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
                  Waiting on Chainlink VRF…
                  {secondsRemaining !== null && !isExpired && (
                    <span className="ml-auto text-zinc-500">expires in {Math.ceil(secondsRemaining / 60)}m</span>
                  )}
                </div>
              )}
              {isExpired && !fulfilled && (
                <button
                  onClick={doCancel}
                  disabled={cancel.isPending || cancelReceipt.isLoading}
                  className="flex h-9 items-center justify-center rounded-lg border border-red-500/40 bg-red-500/10 font-mono text-xs font-bold uppercase tracking-widest text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-50"
                >
                  {cancel.isPending || cancelReceipt.isLoading ? "Cancelling…" : "Cancel expired swap"}
                </button>
              )}
              {cancel.error && <p className="text-red-400">{cancel.error.message.split("\n")[0]}</p>}
            </div>
          )}

          {(approve.error || commit.error || settle.error) && (
            <p className="text-red-400">{(approve.error ?? commit.error ?? settle.error)?.message.split("\n")[0]}</p>
          )}

          {settled && (
            <div className="mt-1 flex flex-col gap-2">
              <div className="flex items-center gap-2 rounded-lg border border-lime-400/40 bg-lime-400/10 px-3 py-2 text-lime-300">
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                Swap settled
              </div>
              {settleReceipt.data && (
                <a
                  href={explorerTxLink(settleReceipt.data.transactionHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-zinc-500 underline hover:text-zinc-300"
                >
                  View on Etherscan ↗
                </a>
              )}
              <button
                onClick={reset}
                className="mt-1 flex h-9 items-center justify-center rounded-lg border border-white/[.12] font-mono text-xs uppercase tracking-widest text-zinc-300 hover:bg-white/[.06]"
              >
                Start another swap
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

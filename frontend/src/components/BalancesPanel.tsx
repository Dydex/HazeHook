import { useEffect } from "react";
import { formatUnits, parseEther, parseUnits } from "viem";
import { useAccount, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { ERC20_ABI, MOCK_TOKEN_ABI, POOL_KEY, TEST_TOKEN_ADDRESS, WETH9_ABI, WETH_ADDRESS } from "@/lib/contracts";

const MINT_HTT_AMOUNT = parseUnits("10", 18); // 10 HTT
const WRAP_WETH_AMOUNT = parseEther("0.005"); // 0.005 Sepolia ETH -> WETH

export function BalancesPanel() {
  const { address, isConnected } = useAccount();

  const { data, isFetching, refetch } = useReadContracts({
    contracts: address
      ? [
          { address: TEST_TOKEN_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [address] },
          { address: WETH_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [address] },
        ]
      : [],
    query: { enabled: !!address },
  });

  const httBalance = data?.[0]?.result as bigint | undefined;
  const wethBalance = data?.[1]?.result as bigint | undefined;

  const mint = useWriteContract();
  const wrap = useWriteContract();
  const mintReceipt = useWaitForTransactionReceipt({ hash: mint.data });
  const wrapReceipt = useWaitForTransactionReceipt({ hash: wrap.data });

  useEffect(() => {
    if (mintReceipt.isSuccess || wrapReceipt.isSuccess) refetch();
  }, [mintReceipt.isSuccess, wrapReceipt.isSuccess, refetch]);

  function mintHtt() {
    if (!address) return;
    mint.writeContract({
      address: TEST_TOKEN_ADDRESS,
      abi: MOCK_TOKEN_ABI,
      functionName: "mint",
      args: [address, MINT_HTT_AMOUNT],
    });
  }

  function wrapWeth() {
    wrap.writeContract({
      address: WETH_ADDRESS,
      abi: WETH9_ABI,
      functionName: "deposit",
      value: WRAP_WETH_AMOUNT,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-white/[.08] bg-white/[.02] p-5">
        <span className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">Your balances</span>

        {!isConnected ? (
          <p className="mt-3 text-sm text-zinc-500">Connect a wallet to see your balances.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-2 font-mono text-sm">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-zinc-300">
                <span className="h-2 w-2 rounded-full bg-lime-400" /> HTT
              </span>
              <span className="text-zinc-100">
                {httBalance !== undefined ? Number(formatUnits(httBalance, 18)).toFixed(4) : isFetching ? "…" : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-zinc-300">
                <span className="h-2 w-2 rounded-full bg-cyan-400" /> WETH
              </span>
              <span className="text-zinc-100">
                {wethBalance !== undefined ? Number(formatUnits(wethBalance, 18)).toFixed(4) : isFetching ? "…" : "—"}
              </span>
            </div>
          </div>
        )}

        {isConnected && (
          <div className="mt-4 flex flex-col gap-2">
            <button
              onClick={mintHtt}
              disabled={mint.isPending || mintReceipt.isLoading}
              className="flex h-9 items-center justify-center rounded-lg border border-lime-400/40 bg-lime-400/10 font-mono text-xs font-bold uppercase tracking-widest text-lime-300 transition-colors hover:bg-lime-400/20 disabled:opacity-50"
            >
              {mint.isPending || mintReceipt.isLoading ? "Minting…" : "Mint 10 HTT"}
            </button>
            <button
              onClick={wrapWeth}
              disabled={wrap.isPending || wrapReceipt.isLoading}
              className="flex h-9 items-center justify-center rounded-lg border border-cyan-400/40 bg-cyan-400/10 font-mono text-xs font-bold uppercase tracking-widest text-cyan-300 transition-colors hover:bg-cyan-400/20 disabled:opacity-50"
            >
              {wrap.isPending || wrapReceipt.isLoading ? "Wrapping…" : "Wrap 0.005 ETH → WETH"}
            </button>
            {(mint.error || wrap.error) && (
              <p className="font-mono text-xs text-red-400">
                {(mint.error ?? wrap.error)?.message.split("\n")[0]}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-white/[.08] bg-white/[.02] p-5">
        <span className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">Pool</span>
        <div className="mt-3 flex flex-col gap-2 font-mono text-sm">
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">Pair</span>
            <span className="text-zinc-100">HTT / WETH</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">Fee tier</span>
            <span className="text-zinc-100">{POOL_KEY.fee / 10_000}%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">Tick spacing</span>
            <span className="text-zinc-100">{POOL_KEY.tickSpacing}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

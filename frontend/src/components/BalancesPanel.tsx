import { useAccount, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { parseUnits } from "viem";
import {
  EXTSLOAD_ABI,
  MOCK_TOKEN_ABI,
  POOL_KEY,
  POOL_MANAGER_ADDRESS,
  poolLiquiditySlot,
  poolStateSlot,
  reservesForLiquidity,
  sqrtPriceX96FromSlot0,
  TEST_TOKEN_ADDRESS,
  tickFromSlot0,
} from "@/lib/contracts";

const MINT_HTT_AMOUNT = parseUnits("10", 18); // 10 HTT

export function BalancesPanel() {
  const { address, isConnected } = useAccount();

  const mint = useWriteContract();
  const mintReceipt = useWaitForTransactionReceipt({ hash: mint.data });

  const { data: poolState } = useReadContracts({
    contracts: [
      { address: POOL_MANAGER_ADDRESS, abi: EXTSLOAD_ABI, functionName: "extsload", args: [poolStateSlot()] },
      { address: POOL_MANAGER_ADDRESS, abi: EXTSLOAD_ABI, functionName: "extsload", args: [poolLiquiditySlot()] },
    ],
    query: { refetchInterval: 15_000 },
  });
  const slot0 = poolState?.[0]?.result;
  const liquiditySlot = poolState?.[1]?.result;
  const reserves =
    slot0 && liquiditySlot
      ? reservesForLiquidity(BigInt(liquiditySlot), sqrtPriceX96FromSlot0(slot0), tickFromSlot0(slot0))
      : undefined;

  function mintHtt() {
    if (!address) return;
    mint.writeContract({
      address: TEST_TOKEN_ADDRESS,
      abi: MOCK_TOKEN_ABI,
      functionName: "mint",
      args: [address, MINT_HTT_AMOUNT],
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-white/[.08] bg-white/[.02] p-5">
        <span className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">Faucet</span>

        {!isConnected ? (
          <p className="mt-3 text-sm text-zinc-500">Connect a wallet to mint test tokens.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            <button
              onClick={mintHtt}
              disabled={mint.isPending || mintReceipt.isLoading}
              className="flex h-9 items-center justify-center rounded-lg border border-lime-400/40 bg-lime-400/10 font-mono text-xs font-bold uppercase tracking-widest text-lime-300 transition-colors hover:bg-lime-400/20 disabled:opacity-50"
            >
              {mint.isPending || mintReceipt.isLoading ? "Minting…" : "Mint 10 HTT"}
            </button>
            {mint.error && <p className="font-mono text-xs text-red-400">{mint.error.message.split("\n")[0]}</p>}
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

        {reserves && (
          <div className="mt-3 flex flex-col gap-2 border-t border-white/[.08] pt-3 font-mono text-sm">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-zinc-300">
                <span className="h-2 w-2 rounded-full bg-lime-400" /> HTT in pool
              </span>
              <span className="text-zinc-100">{reserves.htt.toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-zinc-300">
                <span className="h-2 w-2 rounded-full bg-cyan-400" /> WETH in pool
              </span>
              <span className="text-zinc-100">{reserves.weth.toFixed(4)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

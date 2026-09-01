import { useEffect, useState } from "react";
import { formatUnits, type Log } from "viem";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import {
  HAZE_HOOK_ABI,
  HAZE_HOOK_ADDRESS,
  HAZE_HOOK_DEPLOY_BLOCK,
  POSITION_MANAGER_ABI,
  POSITION_MANAGER_ADDRESS,
} from "@/lib/contracts";

const CHUNK_SIZE = BigInt(2000); // stay under strict public-RPC eth_getLogs range caps

export function RecaptureStats() {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  const [totals, setTotals] = useState<{ htt: bigint; weth: bigint; count: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);
      try {
        const latest = await publicClient!.getBlockNumber();
        const event = HAZE_HOOK_ABI.find((e) => e.type === "event" && e.name === "PremiumRecaptured")!;
        const logs: Log[] = [];

        // Paginate — a single wide-range query silently fails (or errors) on
        // RPCs that cap eth_getLogs to a few thousand blocks per call.
        for (let from = HAZE_HOOK_DEPLOY_BLOCK; from <= latest; from += CHUNK_SIZE + BigInt(1)) {
          const to = from + CHUNK_SIZE < latest ? from + CHUNK_SIZE : latest;
          const chunk = await publicClient!.getLogs({ address: HAZE_HOOK_ADDRESS, event, fromBlock: from, toBlock: to });
          logs.push(...chunk);
          if (cancelled) return;
        }

        let htt = BigInt(0);
        let weth = BigInt(0);
        for (const log of logs) {
          const args = (log as unknown as { args: { isCurrency0?: boolean; amount?: bigint } }).args;
          if (args.isCurrency0) htt += args.amount ?? BigInt(0);
          else weth += args.amount ?? BigInt(0);
        }
        if (!cancelled) setTotals({ htt, weth, count: logs.length });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message.split("\n")[0] : "Couldn't load recapture history.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [publicClient]);

  const { data: positionBalance } = useReadContract({
    address: POSITION_MANAGER_ADDRESS,
    abi: POSITION_MANAGER_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  return (
    <div className="rounded-2xl border border-white/[.08] bg-white/[.02] p-5">
      <span className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">
        Recaptured to LPs (all time)
      </span>
      <p className="mt-1 text-[11px] text-zinc-500">
        Every protected-lane settlement donates a premium straight into the pool&apos;s fee-growth accounting —
        summed here from HazeHook&apos;s own PremiumRecaptured events.
      </p>

      {loading ? (
        <p className="mt-4 font-mono text-sm text-zinc-500">Loading…</p>
      ) : error ? (
        <p className="mt-4 font-mono text-sm text-red-400">{error}</p>
      ) : (
        <div className="mt-4 flex flex-col gap-2 font-mono text-sm">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-zinc-300">
              <span className="h-2 w-2 rounded-full bg-lime-400" /> HTT recaptured
            </span>
            <span className="text-zinc-100">{Number(formatUnits(totals?.htt ?? BigInt(0), 18)).toFixed(4)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-zinc-300">
              <span className="h-2 w-2 rounded-full bg-cyan-400" /> WETH recaptured
            </span>
            <span className="text-zinc-100">{Number(formatUnits(totals?.weth ?? BigInt(0), 18)).toFixed(4)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-zinc-500">
            <span>Settlements</span>
            <span>{totals?.count ?? 0}</span>
          </div>
        </div>
      )}

      {address && (
        <div className="mt-4 border-t border-white/[.08] pt-3 font-mono text-sm">
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">Your LP positions</span>
            <span className="text-zinc-100">{positionBalance !== undefined ? positionBalance.toString() : "…"}</span>
          </div>
          <p className="mt-1 text-[11px] text-zinc-500">
            Recaptured premium accrues as claimable fees on whichever position(s) are in range — same as any
            Uniswap LP position, it shows up when you decrease or collect from it, not as a wallet balance change.
          </p>
        </div>
      )}
    </div>
  );
}

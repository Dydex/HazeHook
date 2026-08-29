import { useState } from "react";
import { parseUnits } from "viem";
import { useAccount, useChainId, useReadContracts, useSwitchChain } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Geist, Geist_Mono } from "next/font/google";
import { HAZE_HOOK_ABI, HAZE_HOOK_ADDRESS, POOL_KEY, SEPOLIA_CHAIN_ID } from "@/lib/contracts";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export default function Home() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const isWrongNetwork = isConnected && chainId !== SEPOLIA_CHAIN_ID;

  const [amount, setAmount] = useState("1");
  const [zeroForOne, setZeroForOne] = useState(true);
  const [submittedAmount, setSubmittedAmount] = useState<string | null>(null);

  const amountSpecified = submittedAmount ? -parseUnits(submittedAmount || "0", 18) : undefined;

  const { data, isFetching, error } = useReadContracts({
    contracts:
      amountSpecified === undefined
        ? []
        : [
            {
              address: HAZE_HOOK_ADDRESS,
              abi: HAZE_HOOK_ABI,
              functionName: "estimatedImpactBps",
              args: [POOL_KEY, zeroForOne, amountSpecified],
            },
            {
              address: HAZE_HOOK_ADDRESS,
              abi: HAZE_HOOK_ABI,
              functionName: "isProtected",
              args: [POOL_KEY, zeroForOne, amountSpecified],
            },
            {
              address: HAZE_HOOK_ADDRESS,
              abi: HAZE_HOOK_ABI,
              functionName: "recommendedSlippageBps",
              args: [POOL_KEY, zeroForOne, amountSpecified],
            },
          ],
    query: { enabled: amountSpecified !== undefined && isConnected },
  });

  const impactBps = data?.[0]?.result as bigint | undefined;
  const isProtected = data?.[1]?.result as boolean | undefined;
  const recommendedSlippageBps = data?.[2]?.result as bigint | undefined;

  return (
    <div
      className={`${geistSans.variable} ${geistMono.variable} flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black`}
    >
      <main className="flex w-full max-w-md flex-col gap-6 rounded-2xl border border-black/[.08] p-8 dark:border-white/[.145]">
        <div>
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">HazeHook</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Sandwich-resistant swaps on Uniswap v4</p>
        </div>

        <ConnectButton />

        {isWrongNetwork && (
          <div className="flex items-center justify-between rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <span>Wrong network — this hook is on Sepolia ({SEPOLIA_CHAIN_ID}).</span>
            <button onClick={() => switchChain({ chainId: SEPOLIA_CHAIN_ID })} className="font-medium underline underline-offset-2">
              Switch
            </button>
          </div>
        )}

        <div className="flex flex-col gap-3 border-t border-black/[.08] pt-6 dark:border-white/[.145]">
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Check swap risk</label>

          <div className="flex gap-2">
            <input
              type="number"
              min="0"
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="flex-1 rounded-lg border border-black/[.08] bg-transparent px-3 py-2 text-sm outline-none dark:border-white/[.145]"
              placeholder="Amount"
            />
            <select
              value={zeroForOne ? "0to1" : "1to0"}
              onChange={(e) => setZeroForOne(e.target.value === "0to1")}
              className="rounded-lg border border-black/[.08] bg-transparent px-2 py-2 text-sm outline-none dark:border-white/[.145]"
            >
              <option value="0to1">HTT → WETH</option>
              <option value="1to0">WETH → HTT</option>
            </select>
          </div>

          <button
            onClick={() => setSubmittedAmount(amount)}
            disabled={!isConnected || isWrongNetwork || isFetching}
            className="flex h-10 items-center justify-center rounded-lg border border-black/[.08] text-sm font-medium transition-colors hover:bg-black/[.04] disabled:opacity-50 dark:border-white/[.145] dark:hover:bg-white/[.06]"
          >
            {isFetching ? "Checking…" : isConnected ? "Check risk" : "Connect a wallet first"}
          </button>

          {error && <p className="text-sm text-red-600 dark:text-red-400">Couldn&apos;t read the pool — try again.</p>}

          {impactBps !== undefined && isProtected !== undefined && recommendedSlippageBps !== undefined && (
            <div className="flex flex-col gap-1 rounded-lg bg-black/[.03] px-4 py-3 text-sm dark:bg-white/[.05]">
              <div className="flex justify-between">
                <span className="text-zinc-500">Price impact</span>
                <span className="font-mono">{Number(impactBps) / 100}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Recommended slippage</span>
                <span className="font-mono">{Number(recommendedSlippageBps) / 100}%</span>
              </div>
              <div className="flex justify-between font-medium">
                <span className={isProtected ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}>
                  {isProtected ? "Protected lane — commit/settle required" : "Fast lane — executes instantly"}
                </span>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

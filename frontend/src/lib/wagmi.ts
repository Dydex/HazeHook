import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { sepolia } from "wagmi/chains";

const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "00000000000000000000000000000000";

export const wagmiConfig = getDefaultConfig({
  appName: "HazeHook",
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: [sepolia],
  ssr: true,
  // Without this, wagmi falls back to viem's default public Sepolia RPC,
  // which caps eth_getLogs to a much smaller block range than this one
  // (verified this endpoint handles 30,000+ block ranges fine).
  transports: {
    [sepolia.id]: http("https://ethereum-sepolia-rpc.publicnode.com"),
  },
});

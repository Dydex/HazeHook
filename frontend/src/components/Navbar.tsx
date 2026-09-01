import Link from "next/link";
import { useRouter } from "next/router";
import { ConnectButton } from "@rainbow-me/rainbowkit";

const LINKS = [
  { label: "Home", href: "/" },
  { label: "Swap", href: "/swap" },
  { label: "Pool", href: "/pool" },
  { label: "About", href: "/about" },
];

export function Navbar() {
  const { pathname } = useRouter();

  return (
    <header className="sticky top-0 z-20 border-b border-white/[.08] bg-[#08080b]/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2">
          <span className="h-6 w-6 rounded-full bg-gradient-to-br from-violet-500 via-pink-500 to-lime-400" />
          <span className="font-mono text-sm font-bold uppercase tracking-widest text-zinc-100">
            haze<span className="text-pink-500">hook</span>
          </span>
        </Link>

        <nav className="hidden items-center gap-8 font-mono text-xs uppercase tracking-widest md:flex">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`transition-colors hover:text-zinc-100 ${
                pathname === link.href ? "text-zinc-100" : "text-zinc-400"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <ConnectButton showBalance={false} chainStatus="icon" accountStatus="address" />
      </div>
    </header>
  );
}

import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS = [
  { to: "/", label: "Dashboard" },
  { to: "/studio", label: "Studio" },
  { to: "/library", label: "Library" },
  { to: "/audit", label: "Audit" },
  { to: "/connectors", label: "Connectors" },
] as const;

export function AppNav({ current }: { current: (typeof ITEMS)[number]["to"] }) {
  return (
    <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
      <Link to="/" className="flex min-w-0 items-center gap-3" aria-label="CardEnhance dashboard">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-elevated text-accent">
          <Zap className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="font-display text-xl tracking-tight sm:text-2xl">CardEnhance</p>
          <p className="truncate text-xs tracking-wide text-muted uppercase">Restore · Compare · Export</p>
        </div>
      </Link>
      <nav aria-label="Primary" className="flex flex-wrap items-center justify-end gap-1">
        {ITEMS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            aria-current={current === item.to ? "page" : undefined}
            className={cn(
              "rounded-lg px-3 py-2 text-sm font-medium",
              current === item.to ? "bg-elevated text-fg" : "text-muted hover:bg-elevated hover:text-fg",
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function PageShell({
  current,
  children,
}: {
  current: (typeof ITEMS)[number]["to"];
  children: ReactNode;
}) {
  return (
    <div className="relative flex min-h-dvh flex-col bg-bg text-fg">
      <header className="border-b border-border bg-surface/80 backdrop-blur-sm">
        <AppNav current={current} />
      </header>
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 px-3 py-4 sm:px-6">{children}</main>
    </div>
  );
}

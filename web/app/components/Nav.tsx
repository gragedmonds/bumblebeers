"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/lineup", label: "Lineup", icon: "📋" },
  { href: "/", label: "Trends", icon: "📈" },
  { href: "/diamond", label: "Diamond", icon: "💎" },
  { href: "/mvp", label: "MVP", icon: "🍺" },
];

export default function Nav() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <>
      {/* Top nav — iPad landscape / desktop (≥ md, 768px+). */}
      <nav className="sticky top-0 z-10 hidden border-b border-amber-200 bg-amber-50/90 backdrop-blur md:block">
        <div className="mx-auto flex max-w-6xl items-center gap-1 overflow-x-auto px-3 py-2">
          <span className="mr-4 text-lg font-bold whitespace-nowrap text-amber-900">
            🐝 Bumblebeers
          </span>
          {links.map((link) => {
            const active = isActive(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`min-h-11 rounded-full px-4 py-2 text-sm font-semibold whitespace-nowrap transition ${
                  active
                    ? "bg-amber-900 text-amber-50"
                    : "text-amber-900 hover:bg-amber-100"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Bottom tab bar — phone & iPad portrait (< md). App-icon style. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-20 border-t border-amber-200 bg-amber-50/95 backdrop-blur md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto flex max-w-6xl items-stretch justify-around px-1 py-1">
          {links.map((link) => {
            const active = isActive(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-label={link.label}
                className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-1 text-[10px] font-semibold transition ${
                  active
                    ? "bg-amber-900 text-amber-50"
                    : "text-amber-900 active:bg-amber-100"
                }`}
              >
                <span className="text-2xl leading-none">{link.icon}</span>
                <span>{link.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}

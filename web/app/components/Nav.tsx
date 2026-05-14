"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/lineup", label: "Lineup" },
  { href: "/", label: "Trends" },
  { href: "/diamond", label: "Diamond" },
  { href: "/mvp", label: "🍺 MVP" },
];

export default function Nav() {
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 z-10 border-b border-amber-200 bg-amber-50/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-1 overflow-x-auto px-3 py-2">
        <span className="mr-4 text-lg font-bold text-amber-900 whitespace-nowrap">
          🐝 Bumblebeers
        </span>
        {links.map((link) => {
          const active =
            link.href === "/"
              ? pathname === "/"
              : pathname.startsWith(link.href);
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
  );
}

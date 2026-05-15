"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

// Single-tone line icons. Inherit `currentColor` so the active/inactive
// nav states drive their colour. Stroke-only — no fills, no gradients.
function ClipboardIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <rect x="6" y="4" width="12" height="17" rx="2" />
      <path d="M9 4h6v3H9z" />
      <path d="M9 11h6M9 15h6" />
    </svg>
  );
}

function TrendIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M7 15l4-4 3 3 5-6" />
    </svg>
  );
}

function ClockIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l2.5 2" />
    </svg>
  );
}

function TrophyIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="M8 4h8v5a4 4 0 1 1-8 0V4z" />
      <path d="M16 6h2.5a1.5 1.5 0 0 1 0 3H16" />
      <path d="M8 6H5.5a1.5 1.5 0 0 0 0 3H8" />
      <path d="M10 13v2.5c0 .8-.5 1.4-1 1.7L8 18h8l-1-.8c-.5-.3-1-.9-1-1.7V13" />
      <path d="M7 20h10" />
    </svg>
  );
}

const links: {
  href: string;
  label: string;
  Icon: ComponentType<IconProps>;
}[] = [
  { href: "/lineup", label: "Lineup", Icon: ClipboardIcon },
  { href: "/", label: "Trends", Icon: TrendIcon },
  { href: "/diamond", label: "History", Icon: ClockIcon },
  { href: "/mvp", label: "MVP", Icon: TrophyIcon },
];

export default function Nav() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <>
      {/* Top nav — iPad landscape / desktop (≥ md, 768px+). */}
      <nav className="sticky top-0 z-10 hidden border-b border-amber-200 bg-amber-50/90 backdrop-blur md:block print:hidden">
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
                className={`flex min-h-11 items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold whitespace-nowrap transition ${
                  active
                    ? "bg-amber-900 text-amber-50"
                    : "text-amber-900 hover:bg-amber-100"
                }`}
              >
                <link.Icon className="h-4 w-4" />
                {link.label}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Bottom tab bar — phone & iPad portrait (< md). App-icon style. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-20 border-t border-amber-200 bg-amber-50/95 backdrop-blur md:hidden print:hidden"
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
                className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 py-1 text-[11px] font-semibold transition ${
                  active
                    ? "bg-amber-900 text-amber-50"
                    : "text-amber-900 active:bg-amber-100"
                }`}
              >
                <link.Icon className="h-6 w-6" />
                <span>{link.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}

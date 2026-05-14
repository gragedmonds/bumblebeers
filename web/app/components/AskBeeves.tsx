"use client";

// Persistent floating button — "Ask Beeves" (the bee butler). Lives in the
// bottom-right corner of every page; tap to jump to /ask. Hides itself when
// /ask is the current page so it doesn't sit on top of the chat UI.

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function AskBeeves() {
  const pathname = usePathname();
  if (pathname.startsWith("/ask")) return null;

  return (
    <Link
      href="/ask"
      aria-label="Ask the Beeves"
      title="Ask the Bee — natural-language Q&A over the stats"
      className="fixed bottom-4 right-4 z-30 inline-flex h-14 w-14 items-center justify-center rounded-full bg-amber-700 text-2xl text-white shadow-lg ring-1 ring-amber-900/20 transition hover:scale-105 hover:bg-amber-800 active:scale-95 sm:bottom-6 sm:right-6 sm:h-16 sm:w-16 sm:text-3xl"
    >
      <span className="sr-only">Ask the Beeves</span>
      <span aria-hidden>🐝</span>
    </Link>
  );
}

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Nav from "./components/Nav";
import AskBeeves from "./components/AskBeeves";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Bumblebeers",
  description:
    "Adult slo-pitch stats, BMBL+ rankings, lineup notes, and a 🐝 you can ask anything.",
};

// Honeycomb pattern — very subtle hex outlines tiled across the page background.
// Inline SVG (data URI) so there's no extra network request and no asset file
// to maintain. Amber-900 stroke at ~4% opacity → felt, not seen.
const HONEYCOMB =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='100' viewBox='0 0 56 100'%3E%3Cpath fill='none' stroke='%23b45309' stroke-opacity='0.06' stroke-width='1' d='M28 66L0 50V16l28-16 28 16v34L28 66z'/%3E%3C/svg%3E\")";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body
        className="min-h-full flex flex-col bg-amber-50/30 text-stone-900"
        style={{ backgroundImage: HONEYCOMB, backgroundAttachment: "fixed" }}
      >
        <Nav />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-28 sm:pb-6">
          {children}
        </main>
        <AskBeeves />
      </body>
    </html>
  );
}

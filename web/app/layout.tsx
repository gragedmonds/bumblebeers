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

// Honeycomb pattern lives on body::before in globals.css — masked radial
// vignette of tiny hex "dots" that fade from a strong centre out to
// transparent at the edges. Mimics the Claude Code welcome-screen aesthetic.

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
      <body className="min-h-full flex flex-col bg-amber-50/30 text-stone-900">
        <Nav />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-28 sm:pb-6">
          {children}
        </main>
        <AskBeeves />
      </body>
    </html>
  );
}

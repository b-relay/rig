import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "./globals.css";
import { TopBar } from "@/components/top-bar";
import { BottomTabs } from "@/components/nav";

const archivo = localFont({
  src: "../../node_modules/@fontsource-variable/archivo/files/archivo-latin-standard-normal.woff2",
  variable: "--font-archivo",
  weight: "100 900",
  display: "swap",
  declarations: [{ prop: "font-stretch", value: "62% 125%" }],
});
const martian = localFont({
  src: "../../node_modules/@fontsource-variable/martian-mono/files/martian-mono-latin-wght-normal.woff2",
  variable: "--font-martian",
  weight: "100 800",
  display: "swap",
});
export const metadata: Metadata = {
  title: { default: "Rig", template: "%s · Rig" },
  description: "The Projects this Mac runs.",
};
export const viewport: Viewport = {
  themeColor: "#16202b",
  width: "device-width",
  initialScale: 1,
};
/** Every page reads rigd when it is requested; nothing here is prerendered. */
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${martian.variable}`}>
      <body className="min-h-dvh pb-16 sm:pb-0">
        <TopBar />
        <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-6 sm:px-6">
          {children}
        </main>
        <BottomTabs />
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "./globals.css";
import { TopBar } from "@/components/top-bar";
import { BottomTabs } from "@/components/nav";
import { Sidebar } from "@/components/shell/sidebar";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";
import { SIGNING_IN_HEADER } from "@/server/signing-in";
import { site } from "@/server/site";

/* Fonts ship with the site (next/font/local over the fontsource files), so no page asks another
   server for CSS or type at runtime. Inter sets the page, Space Grotesk the Project monograms,
   JetBrains Mono the code, logs and ports. */
const inter = localFont({
  src: "../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});
const spaceGrotesk = localFont({
  src: "../../node_modules/@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2",
  variable: "--font-space-grotesk",
  weight: "300 700",
  display: "swap",
});
const jetbrains = localFont({
  src: "../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
  variable: "--font-jetbrains",
  weight: "100 800",
  display: "swap",
});
export const metadata: Metadata = {
  title: { default: "Rig", template: "%s · Rig" },
  description: "The Projects this Mac runs.",
};
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1012" },
  ],
  width: "device-width",
  initialScale: 1,
};
/** Every page reads rigd when it is requested; nothing here is prerendered. */
export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // A browser that has yet to sign in gets the frame without the sections and without rigd's state.
  const signingIn = (await headers()).get(SIGNING_IN_HEADER) === "1";
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const sandbox = site().sandboxRoot !== undefined;
  return (
    <html
      lang="en"
      data-theme={theme}
      className={`${inter.variable} ${spaceGrotesk.variable} ${jetbrains.variable}`}
    >
      <body className="min-h-dvh pb-[calc(4rem+env(safe-area-inset-bottom))] sm:pb-0">
        {signingIn ? (
          <>
            <TopBar bare theme={theme} />
            <main className="mx-auto flex w-full max-w-md flex-col gap-8 px-4 py-10 sm:py-16">
              {children}
            </main>
          </>
        ) : (
          <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
            <aside className="sticky top-0 hidden h-dvh border-r border-sidebar-border bg-sidebar lg:block">
              <Sidebar sandbox={sandbox} />
            </aside>
            <div className="flex min-w-0 flex-col">
              <TopBar theme={theme} menu={<Sidebar sandbox={sandbox} />} />
              <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 pt-5 pb-8 sm:px-6 sm:pt-6 lg:px-8">
                {children}
              </main>
            </div>
          </div>
        )}
        {signingIn ? null : <BottomTabs />}
      </body>
    </html>
  );
}

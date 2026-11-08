import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "./globals.css";
import { TopBar } from "@/components/top-bar";
import { BottomTabs } from "@/components/nav";
import { CONTENT_ID, SkipToContent } from "@/components/bits";
import { Navigation } from "@/components/shell/navigation";
import { Sidebar } from "@/components/shell/sidebar";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";
import { sessionHeld } from "@/server/session";
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
  // A request without a session gets the frame without the sections and without rigd's state: the sign-in page, or a
  // not-found page for a path the proxy lets through without one.
  const signingIn = !(await sessionHeld());
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const sandbox = site().sandboxRoot !== undefined;
  return (
    <html
      lang="en"
      data-theme={theme}
      className={`${inter.variable} ${spaceGrotesk.variable} ${jetbrains.variable}`}
    >
      <body className="min-h-dvh pb-[calc(4rem+env(safe-area-inset-bottom))] sm:pb-0">
        {signingIn ? null : <SkipToContent />}
        {signingIn ? (
          <>
            <TopBar bare theme={theme} />
            <main className="mx-auto flex w-full max-w-md flex-col gap-8 px-4 py-10 sm:py-16">
              {children}
            </main>
          </>
        ) : (
          <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
            {/* One sidebar, beside the page or in the top bar's drawer, so a page renders and sends it once. */}
            <Navigation sidebar={<Sidebar sandbox={sandbox} />}>
              <div className="flex min-w-0 flex-col">
                <TopBar theme={theme} />
                <main
                  id={CONTENT_ID}
                  tabIndex={-1}
                  className="mx-auto flex w-full max-w-7xl scroll-mt-14 flex-col gap-6 px-4 pt-5 pb-8 outline-none sm:px-6 sm:pt-6 lg:px-8"
                >
                  {children}
                </main>
              </div>
            </Navigation>
          </div>
        )}
        {signingIn ? null : <BottomTabs />}
      </body>
    </html>
  );
}

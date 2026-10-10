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
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f4f1" },
    { media: "(prefers-color-scheme: dark)", color: "#121312" },
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
      className={`${archivo.variable} ${martian.variable}`}
    >
      <body className="min-h-dvh pb-16 sm:pb-0">
        {signingIn ? (
          <>
            <TopBar bare theme={theme} />
            <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-6 sm:px-6">
              {children}
            </main>
          </>
        ) : (
          <div className="lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)]">
            <aside className="sticky top-0 hidden h-dvh border-r border-rule bg-sheet lg:block">
              <Sidebar sandbox={sandbox} />
            </aside>
            <div className="flex min-w-0 flex-col">
              <TopBar theme={theme} menu={<Sidebar sandbox={sandbox} />} />
              <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
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

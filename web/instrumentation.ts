/** Next calls this once when the server starts, before it answers requests. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startSite } = await import("./server/startup");
  const { site } = await import("./server/site");
  await startSite(site());
}

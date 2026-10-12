import { Gauge, LayoutGrid, Network } from "lucide-react";

/** The Host-wide sections, in the sidebar on wide screens and along the bottom on a phone. Monitor holds rigd, Doctor
 * and Activity beside what every Project uses. */
export const SECTIONS = [
  { href: "/", label: "Overview", icon: LayoutGrid, exact: true },
  { href: "/monitor", label: "Monitor", icon: Gauge },
  { href: "/proxy", label: "Proxy", icon: Network },
] as const;

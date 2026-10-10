import {
  Activity,
  LayoutGrid,
  Network,
  Server,
  Stethoscope,
} from "lucide-react";

/** The Host-wide sections, in the sidebar on wide screens and along the bottom on a phone. */
export const SECTIONS = [
  { href: "/", label: "Overview", icon: LayoutGrid, exact: true },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/proxy", label: "Proxy", icon: Network },
  { href: "/doctor", label: "Doctor", icon: Stethoscope },
  { href: "/rigd", label: "rigd", icon: Server },
] as const;

import { redirect } from "next/navigation";

/** rigd, its queue and its uninstall readiness are on Monitor now. */
export default function RigdPage() {
  redirect("/monitor");
}

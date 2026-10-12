import { redirect } from "next/navigation";

/** Doctor's Host checks are on Monitor now, beside rigd and Activity. */
export default function DoctorPage() {
  redirect("/monitor");
}

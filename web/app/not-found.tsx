import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col gap-2 py-10">
      <h1 className="title text-2xl">Not here</h1>
      <p className="text-sm text-muted-foreground">
        Nothing is served at this address.{" "}
        <Link href="/">Back to the board.</Link>
      </p>
    </div>
  );
}

"use client";

import NextLink from "next/link";
import { useState, type ComponentProps } from "react";

/** The site's link: Next's, prefetching its page only once someone shows they may follow it (pointing at it, touching it
 * or moving focus to it) rather than whenever it is on screen. Every live refresh would otherwise prefetch every link on
 * the page again, nearly all of them pages nobody opens. */
export default function Link({
  prefetch,
  onMouseEnter,
  onTouchStart,
  onFocus,
  ...props
}: ComponentProps<typeof NextLink>) {
  const [intent, setIntent] = useState(false);
  return (
    <NextLink
      {...props}
      prefetch={intent ? (prefetch ?? null) : false}
      onMouseEnter={(event) => {
        setIntent(true);
        onMouseEnter?.(event);
      }}
      onTouchStart={(event) => {
        setIntent(true);
        onTouchStart?.(event);
      }}
      onFocus={(event) => {
        setIntent(true);
        onFocus?.(event);
      }}
    />
  );
}

"use client";

import { useEffect, useState } from "react";

/**
 * Returns true only after the component has mounted on the client. Use to gate
 * wallet/wagmi-dependent UI that must not render during SSR / first paint.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

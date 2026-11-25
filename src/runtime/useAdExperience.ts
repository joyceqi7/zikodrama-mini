import { useSyncExternalStore } from "react";

import { useRuntime } from "./RuntimeContext";

export function useAdExperience() {
  const runtime = useRuntime();
  return useSyncExternalStore(
    runtime.subscribeAdExperience,
    runtime.getAdExperience,
    runtime.getAdExperience,
  );
}

// Live online/offline indicator for the status-bar badge. Offline-first is
// mandatory (architecture §1.2): the app works from the local encrypted store
// and only shows "syncing" reachability as status. Defaults to online when the
// environment does not expose navigator.onLine.

import { useEffect, useState } from "react";

export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(() => globalThis.navigator?.onLine ?? true);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    globalThis.addEventListener?.("online", on);
    globalThis.addEventListener?.("offline", off);
    return () => {
      globalThis.removeEventListener?.("online", on);
      globalThis.removeEventListener?.("offline", off);
    };
  }, []);

  return online;
}

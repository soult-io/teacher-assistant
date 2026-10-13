// Platform gates for device setup (device-enrollment-spec rev 2.4 §13 A-3).
//
// On iOS, Safari and the Home Screen app keep separate storage, and WebKit deletes all
// script-writable storage (IndexedDB included) after seven days of Safari use without
// interaction on the site; Home Screen apps have their own counter. A vault created in a
// Safari tab can therefore vanish silently and leave an orphan owner key on the relay,
// so on iOS setup and pairing run only in the installed Home Screen app.
//
// Everywhere, setup asks for persistent storage. A refusal is reported (the UI shows a
// one-line warning) but never blocks setup.

/** The browser facts the gates read. Injected so tests never touch the real navigator. */
export interface PlatformEnv {
  readonly userAgent: string;
  readonly platform: string;
  readonly maxTouchPoints: number;
  /** `matchMedia('(display-mode: standalone)').matches`. */
  readonly standaloneMedia: boolean;
  /** iOS-only `navigator.standalone`; undefined elsewhere. */
  readonly navigatorStandalone: boolean | undefined;
  /** `navigator.storage.persist`, when the browser has it. */
  readonly persist: (() => Promise<boolean>) | undefined;
}

/** Read the live browser environment. */
export function browserPlatform(): PlatformEnv {
  const nav = globalThis.navigator as Navigator & { readonly standalone?: boolean };
  const storage = nav.storage as StorageManager | undefined;
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    standaloneMedia: globalThis.matchMedia?.("(display-mode: standalone)").matches ?? false,
    navigatorStandalone: nav.standalone,
    persist: storage?.persist === undefined ? undefined : () => storage.persist(),
  };
}

function isIos(env: PlatformEnv): boolean {
  // iPadOS reports a desktop Mac; touch points tell it apart from a real Mac.
  return (
    /iPad|iPhone|iPod/.test(env.userAgent) ||
    /iPad|iPhone|iPod/.test(env.platform) ||
    (env.platform === "MacIntel" && env.maxTouchPoints > 1)
  );
}

/** True when this is iOS but not the installed Home Screen app: setup and pairing are blocked. */
export function isIosOutsideHomeScreen(env: PlatformEnv): boolean {
  return isIos(env) && !env.standaloneMedia && env.navigatorStandalone !== true;
}

/** Ask the browser to keep this origin's storage. Resolves false when refused or unsupported. */
export async function requestPersistentStorage(env: PlatformEnv): Promise<boolean> {
  if (env.persist === undefined) {
    return false;
  }
  try {
    return await env.persist();
  } catch {
    return false;
  }
}

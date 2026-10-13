// EU-6 — A-3: on iOS, setup and pairing run only in the installed Home Screen app;
// navigator.storage.persist() is requested everywhere.

import { describe, expect, it } from "vitest";
import { isIosOutsideHomeScreen, type PlatformEnv, requestPersistentStorage } from "./platform.js";

const base: PlatformEnv = {
  userAgent: "",
  platform: "",
  maxTouchPoints: 0,
  standaloneMedia: false,
  navigatorStandalone: undefined,
  persist: () => Promise.resolve(true),
};

describe("isIosOutsideHomeScreen", () => {
  it("blocks iPhone Safari (not standalone)", () => {
    expect(
      isIosOutsideHomeScreen({
        ...base,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
        platform: "iPhone",
        navigatorStandalone: false,
      }),
    ).toBe(true);
  });

  it("blocks iPadOS presenting as a Mac with touch", () => {
    expect(
      isIosOutsideHomeScreen({
        ...base,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        platform: "MacIntel",
        maxTouchPoints: 5,
        navigatorStandalone: false,
      }),
    ).toBe(true);
  });

  it("allows the iOS Home Screen app", () => {
    const ios = { ...base, userAgent: "iPhone", platform: "iPhone" };
    expect(isIosOutsideHomeScreen({ ...ios, standaloneMedia: true })).toBe(false);
    expect(isIosOutsideHomeScreen({ ...ios, navigatorStandalone: true })).toBe(false);
  });

  it("never blocks Android, desktop Chrome or a desktop Mac", () => {
    expect(isIosOutsideHomeScreen({ ...base, userAgent: "Android 14; Pixel 8a" })).toBe(false);
    expect(isIosOutsideHomeScreen({ ...base, platform: "Win32" })).toBe(false);
    expect(isIosOutsideHomeScreen({ ...base, platform: "MacIntel", maxTouchPoints: 0 })).toBe(
      false,
    );
  });
});

describe("requestPersistentStorage", () => {
  it("returns the browser's answer, and false when the API is missing or throws", async () => {
    expect(await requestPersistentStorage({ ...base, persist: () => Promise.resolve(true) })).toBe(
      true,
    );
    expect(await requestPersistentStorage({ ...base, persist: () => Promise.resolve(false) })).toBe(
      false,
    );
    expect(await requestPersistentStorage({ ...base, persist: undefined })).toBe(false);
    expect(
      await requestPersistentStorage({ ...base, persist: () => Promise.reject(new Error("x")) }),
    ).toBe(false);
  });
});

// Vitest setup: jest-dom matchers + an in-memory IndexedDB (fake-indexeddb) so
// the ciphertext-persistence tests exercise the real IDB code path without a
// browser. Only used under test.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";

// Unmount React trees between tests so queries don't see a prior test's DOM.
afterEach(() => {
  cleanup();
});

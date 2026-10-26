// [A1] The square code (spec §13 A-5): a QR whose payload is the raw pairing code — the
// 52 Crockford characters, not a URL — so a system camera app that scans it gets no link,
// and the secret never lands in browser history. Drawn as one SVG path from the bundled
// encoder (no external script, no data URL, no innerHTML).

import qrcode from "qrcode-generator";
import { useMemo } from "react";

/** Quiet zone around the code, in modules (the QR standard asks for 4). */
const QUIET = 4;

/** The QR payload for a pairing code: its characters without the group separators. */
export function qrPayload(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

export function QrCode({ code }: { readonly code: string }) {
  const { path, size } = useMemo(() => {
    // Crockford's alphabet is inside QR's alphanumeric set: a compact, low-version code.
    const qr = qrcode(0, "M");
    qr.addData(qrPayload(code), "Alphanumeric");
    qr.make();
    const count = qr.getModuleCount();
    let d = "";
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) {
          d += `M${col + QUIET} ${row + QUIET}h1v1h-1z`;
        }
      }
    }
    return { path: d, size: count + 2 * QUIET };
  }, [code]);
  return (
    <svg
      className="qrcode"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Square code for your other device to scan"
      shapeRendering="crispEdges"
      data-testid="pair-qr"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

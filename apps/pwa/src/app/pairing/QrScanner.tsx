// [B1] The in-app scanner (spec §13 A-5): the camera through getUserMedia and the QR
// decoder bundled in the app shell (jsQR, pinned). Frames are read into a canvas in
// memory, never stored or sent; the first decoded text goes to the pairing and the camera
// is turned off. A blocked or missing camera hands over to the typed code.

import jsQR from "jsqr";
import { useEffect, useRef } from "react";

const SCAN_EVERY_MS = 250;

export interface QrScannerProps {
  readonly onResult: (text: string) => void;
  /** The camera is blocked, missing, or the browser has none for this app. */
  readonly onBlocked: () => void;
  /** Test seam: the media devices (defaults to navigator.mediaDevices). */
  readonly mediaDevices?: Pick<MediaDevices, "getUserMedia"> | undefined;
}

export function QrScanner({ onResult, onBlocked, mediaDevices }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // The callbacks may change identity between renders; the camera starts once.
  const handlers = useRef({ onResult, onBlocked });
  handlers.current = { onResult, onBlocked };

  useEffect(() => {
    const media = mediaDevices ?? globalThis.navigator?.mediaDevices;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let live = true;
    const stop = () => {
      clearInterval(timer);
      for (const track of stream?.getTracks() ?? []) {
        track.stop();
      }
      stream = null;
    };
    if (media?.getUserMedia === undefined) {
      handlers.current.onBlocked();
      return;
    }
    const canvas = document.createElement("canvas");
    const scan = () => {
      const video = videoRef.current;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (video === null || context === null || video.readyState < 2) {
        return;
      }
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = context.getImageData(0, 0, canvas.width, canvas.height);
      const found = jsQR(frame.data, frame.width, frame.height, {
        inversionAttempts: "dontInvert",
      });
      frame.data.fill(0);
      if (found !== null && found.data.length > 0) {
        stop();
        handlers.current.onResult(found.data);
      }
    };
    media.getUserMedia({ video: { facingMode: "environment" }, audio: false }).then(
      (opened) => {
        stream = opened;
        if (!live) {
          stop();
          return;
        }
        const video = videoRef.current;
        if (video !== null) {
          video.srcObject = opened;
          void video.play().catch(() => {});
        }
        timer = setInterval(scan, SCAN_EVERY_MS);
      },
      () => {
        if (live) {
          handlers.current.onBlocked();
        }
      },
    );
    return () => {
      live = false;
      stop();
    };
  }, [mediaDevices]);

  return (
    <div className="qrscanner">
      <video ref={videoRef} muted playsInline aria-label="Camera view" data-testid="pair-camera" />
    </div>
  );
}

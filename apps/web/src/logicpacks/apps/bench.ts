/**
 * Benchmark probes for the app-sharing harness (apps/web/e2e/logicpacks-app-stream.bench.mjs).
 * Installed on `window.__lpBench` while the live page is open. Input-to-photon:
 * send one input, then watch arriving frames until a region of the picture
 * changes. Measured on the viewer's own clock, so no clock sync is needed.
 */
import type { AppStreamInput } from "@logicpacks/contracts";

import type { AppStreamSession } from "./appStreamSession";

const W = 96;
const H = 60;

type Region = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

function grab(
  source: CanvasImageSource,
  canvas: HTMLCanvasElement,
  region: Region,
  sw: number,
  sh: number,
) {
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(source, region.x * sw, region.y * sh, region.w * sw, region.h * sh, 0, 0, W, H);
  return context.getImageData(0, 0, W, H).data;
}

function diff(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let sum = 0;
  for (let index = 0; index < a.length; index += 4) {
    sum +=
      Math.abs(a[index]! - b[index]!) +
      Math.abs(a[index + 1]! - b[index + 1]!) +
      Math.abs(a[index + 2]! - b[index + 2]!);
  }
  return sum / ((a.length / 4) * 3);
}

type FrameSink = (atMs: number, source: CanvasImageSource, w: number, h: number) => void;

/** Frames straight off the host's capture track: the baseline without encode or network. */
function watchTrack(track: MediaStreamTrack, onFrame: FrameSink) {
  const Processor = (
    globalThis as unknown as {
      MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => {
        readable: ReadableStream<VideoFrame>;
      };
    }
  ).MediaStreamTrackProcessor;
  const clone = track.clone();
  const reader = new Processor({ track: clone }).readable.getReader();
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      onFrame(performance.now(), frame, frame.displayWidth, frame.displayHeight);
      frame.close();
    }
  })().catch(() => undefined);
  return () => {
    stopped = true;
    void reader.cancel().catch(() => undefined);
    clone.stop();
  };
}

/** Calls `onFrame` with the frame's display time for every new picture, until stopped. */
function watchFrames(onFrame: FrameSink, session: AppStreamSession) {
  let stopped = false;
  const video = document.querySelector<HTMLVideoElement>("[data-testid=live-machine-video]");
  if (video && "requestVideoFrameCallback" in video) {
    const loop = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (stopped) return;
      onFrame(
        meta.expectedDisplayTime ?? performance.now(),
        video,
        video.videoWidth,
        video.videoHeight,
      );
      video.requestVideoFrameCallback(loop);
    };
    video.requestVideoFrameCallback(loop);
    return () => {
      stopped = true;
    };
  }
  const listener = () => {
    const img = document.querySelector<HTMLImageElement>("[data-testid=live-machine-frame]");
    if (!img) return;
    const arrived = performance.now();
    const ready = () => onFrame(arrived, img, img.naturalWidth, img.naturalHeight);
    if (img.complete) ready();
    else img.addEventListener("load", ready, { once: true });
  };
  session.frameListeners.add(listener);
  return () => session.frameListeners.delete(listener);
}

export function installBenchProbe(session: AppStreamSession) {
  // The host's latest raw capture frame, kept so a local measurement has a baseline.
  let lastLocal: VideoFrame | null = null;
  let keeperTrack: MediaStreamTrack | null = null;
  let stopKeeper: (() => void) | null = null;
  const keepLocal = () => {
    const track = session.hostTrack();
    if (track === keeperTrack) return;
    stopKeeper?.();
    keeperTrack = track;
    stopKeeper = track
      ? watchTrack(track, (_at, source) => {
          lastLocal?.close();
          lastLocal = (source as VideoFrame).clone();
        })
      : null;
  };
  const keeperTimer = setInterval(keepLocal, 500);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const probe = {
    snapshot: () => session.getSnapshot(),
    /** Host capture state, for diagnosing a stalled run. */
    trackState: () => {
      const track = session.hostTrack();
      return track
        ? {
            readyState: track.readyState,
            muted: track.muted,
            enabled: track.enabled,
            settings: track.getSettings(),
          }
        : null;
    },
    /** Frames per second actually painted over `ms`, and the receiver's own stats. */
    sampleFrames: (ms: number, local = false) =>
      new Promise<{ frames: number; fps: number; gaps: number[] }>((resolve) => {
        const times: number[] = [];
        const track = local ? session.hostTrack() : null;
        const stop = track
          ? watchTrack(track, (at) => times.push(at))
          : watchFrames((at) => times.push(at), session);
        setTimeout(() => {
          stop();
          const gaps = times.slice(1).map((t, i) => t - times[i]!);
          resolve({ frames: times.length, fps: (times.length * 1000) / ms, gaps });
        }, ms);
      }),
    /** Sends input through the viewer's control path, as the live view does. */
    input: (events: ReadonlyArray<AppStreamInput>) => {
      for (const ev of events) session.input(ev);
    },
    /** Switches this viewer to the JPEG relay, as if no peer connection could be made. */
    forceJpeg: () => session.useJpeg(),
    inputToPhoton: (input: {
      ev: AppStreamInput | ReadonlyArray<AppStreamInput>;
      region?: Region;
      threshold?: number;
      timeoutMs?: number;
      local?: boolean;
    }) =>
      new Promise<number | null>((resolve) => {
        const region = input.region ?? { x: 0, y: 0, w: 1, h: 1 };
        const threshold = input.threshold ?? 3;
        let baseline: Uint8ClampedArray | null = null;
        let sentAt = 0;
        let done = false;
        let maxChange = 0;
        let frames = 0;
        let quiet: ReturnType<typeof setTimeout> | null = null;
        const finish = (value: number | null) => {
          if (done) return;
          done = true;
          if (quiet) clearTimeout(quiet);
          stop();
          (window as unknown as { __lpLastProbe?: unknown }).__lpLastProbe = {
            maxChange,
            frames,
            baseline: baseline !== null,
          };
          resolve(value);
        };
        const events = Array.isArray(input.ev) ? input.ev : [input.ev as AppStreamInput];
        const send = () => {
          if (input.local) {
            const windowId = session.getSnapshot().sharing?.windowId;
            for (const ev of events) {
              if (windowId != null) void window.desktopBridge?.appShare?.inject(windowId, ev);
            }
          } else {
            for (const ev of events) session.input(ev);
          }
        };
        const onFrame: FrameSink = (at, source, sw, sh) => {
          if (sw === 0 || done) return;
          const pixels = grab(source, canvas, region, sw, sh);
          if (sentAt === 0) {
            // Wait for a still picture first (an encoder still refining, or a redraw in flight,
            // would otherwise count as the response): send once 400 ms pass with no change.
            if (baseline === null || diff(pixels, baseline) >= threshold / 2) {
              baseline = new Uint8ClampedArray(pixels);
              if (quiet) clearTimeout(quiet);
              quiet = setTimeout(() => {
                if (done) return;
                sentAt = performance.now();
                send();
              }, 400);
            }
            return;
          }
          const change = diff(pixels, baseline!);
          maxChange = Math.max(maxChange, change);
          frames += 1;
          if (change >= threshold) finish(Math.max(0, at - sentAt));
        };
        const track = input.local ? session.hostTrack() : null;
        const stop = track ? watchTrack(track, onFrame) : watchFrames(onFrame, session);
        // Capture only delivers frames when pixels change, so a still window sends none: take the
        // baseline from what is on screen now (the viewer's picture, or the host's last raw frame).
        const current = input.local
          ? lastLocal
          : (document.querySelector<HTMLVideoElement>("[data-testid=live-machine-video]") ??
            document.querySelector<HTMLImageElement>("[data-testid=live-machine-frame]"));
        if (current) {
          const width =
            current instanceof HTMLVideoElement
              ? current.videoWidth
              : current instanceof HTMLImageElement
                ? current.naturalWidth
                : current.displayWidth;
          const height =
            current instanceof HTMLVideoElement
              ? current.videoHeight
              : current instanceof HTMLImageElement
                ? current.naturalHeight
                : current.displayHeight;
          if (width > 0) onFrame(performance.now(), current, width, height);
        }
        setTimeout(() => finish(null), (input.timeoutMs ?? 3000) + 1500);
      }),
  };
  (window as unknown as { __lpBench?: typeof probe }).__lpBench = probe;
  return () => {
    clearInterval(keeperTimer);
    stopKeeper?.();
    lastLocal?.close();
    delete (window as unknown as { __lpBench?: typeof probe }).__lpBench;
  };
}

/**
 * One person's side of a live app share. The host (desktop app) captures one
 * window with getUserMedia and sends it to each viewer over its own WebRTC
 * peer connection; the LogicPacks server only relays the offer, answer and ICE
 * candidates. A viewer whose peer connection does not come up within a few
 * seconds switches to JPEG frames relayed through the server.
 *
 * Control: a viewer's input goes over the peer's data channel (or the server
 * socket on the fallback). The server forwards socket input only from people
 * with a live grant, and the host checks the grant list again before it
 * injects anything into the shared window, whichever way the input came.
 */
import type {
  AppStreamClientMessage,
  AppStreamIceServer,
  AppStreamInput,
  AppStreamLogEntry,
  AppStreamPerson,
  AppStreamServerMessage,
  AppStreamSharedApp,
  AppStreamState,
  DesktopShareableWindow,
} from "@logicpacks/contracts";

import { lpAbsoluteUrl, lpApi } from "../api";

export type AppStreamTransport = "connecting" | "webrtc" | "jpeg" | "none";

export interface AppStreamCursor {
  readonly key: string;
  readonly name: string;
  readonly colorIndex: number;
  readonly x: number;
  readonly y: number;
  readonly controlling: boolean;
  readonly atMs: number;
}

export interface AppStreamStats {
  readonly transport: AppStreamTransport;
  readonly rttMs: number | null;
  readonly fps: number | null;
  readonly bitrateKbps: number | null;
  readonly framesDecoded: number | null;
  readonly framesDropped: number | null;
  readonly jitterBufferMs: number | null;
  readonly codec: string | null;
  readonly width: number | null;
  readonly height: number | null;
}

export interface AppStreamSnapshot {
  readonly connected: boolean;
  readonly error: string | null;
  readonly you: AppStreamPerson | null;
  readonly canHost: boolean;
  readonly state: AppStreamState | null;
  readonly log: ReadonlyArray<AppStreamLogEntry>;
  readonly cursors: ReadonlyArray<AppStreamCursor>;
  readonly stats: AppStreamStats;
  /** Viewers: the live picture. Hosts: the local preview of what is shared. */
  readonly stream: MediaStream | null;
  /** JPEG fallback: an object URL of the newest frame. */
  readonly frameUrl: string | null;
  readonly sharing: AppStreamSharedApp | null;
  /** Host: the shared window runs on the hidden display, off the host's own screen. */
  readonly hidden: boolean;
  /** Host: why the hidden display could not be used, if it was asked for and refused. */
  readonly hiddenError: string | null;
}

const PEER_TIMEOUT_MS = 8000;
const JPEG_FPS = 15;

const emptyStats: AppStreamStats = {
  transport: "none",
  rttMs: null,
  fps: null,
  bitrateKbps: null,
  framesDecoded: null,
  framesDropped: null,
  jitterBufferMs: null,
  codec: null,
  width: null,
  height: null,
};

interface Peer {
  readonly pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  subject: string | null;
}

export class AppStreamSession {
  private socket: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private snapshot: AppStreamSnapshot;
  private iceServers: ReadonlyArray<AppStreamIceServer> = [];
  private readonly peers = new Map<string, Peer>();
  private hostStream: MediaStream | null = null;
  private sharedWindowId: number | null = null;
  private jpegTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private peerTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBytes: { bytes: number; at: number } | null = null;
  private closed = false;
  private generation = 0;
  private killOff: (() => void) | null = null;
  private jpegStop: (() => void) | null = null;
  /** Benchmark probes listen to every arriving frame. */
  readonly frameListeners = new Set<(atMs: number) => void>();

  constructor(
    readonly projectId: string,
    readonly role: "host" | "viewer",
  ) {
    this.snapshot = {
      connected: false,
      error: null,
      you: null,
      canHost: false,
      state: null,
      log: [],
      cursors: [],
      stats: { ...emptyStats, transport: role === "viewer" ? "connecting" : "none" },
      stream: null,
      frameUrl: null,
      sharing: null,
      hidden: false,
      hiddenError: null,
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private set(patch: Partial<AppStreamSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private send(message: AppStreamClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  async connect(): Promise<void> {
    // React may close and reconnect the same session (strict mode): only the latest connect wins.
    const generation = ++this.generation;
    this.closed = false;
    let ticket;
    try {
      ticket = await lpApi.appStreamTicket(this.projectId);
    } catch (error) {
      this.set({ error: error instanceof Error ? error.message : "Could not join." });
      return;
    }
    if (this.closed || generation !== this.generation) return;
    this.set({ canHost: ticket.canHost });
    const url = new URL(
      lpAbsoluteUrl(
        `/api/lp/appstream/ws?ticket=${encodeURIComponent(ticket.ticket)}&role=${this.role}`,
      ),
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.binaryType = "blob";
    this.socket = socket;
    socket.onopen = () => this.set({ connected: true, error: null });
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.set({
        connected: false,
        ...(event.code === 4409 ? { error: "Another window took over hosting." } : {}),
      });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data === "string") {
        this.onMessage(JSON.parse(event.data) as AppStreamServerMessage);
      } else {
        this.onFrame(event.data as Blob);
      }
    };
    this.pingTimer = setInterval(() => this.send({ t: "ping", at: performance.now() }), 2000);
    this.statsTimer = setInterval(() => void this.collectStats(), 1000);
    if (this.role === "host" && window.desktopBridge?.appShare) {
      this.killOff = window.desktopBridge.appShare.onKill(() => this.kill());
    }
  }

  close() {
    this.closed = true;
    this.generation++;
    if (this.role === "host") void this.stopSharing();
    this.killOff?.();
    for (const timer of [this.pingTimer, this.statsTimer, this.jpegTimer]) {
      if (timer) clearInterval(timer);
    }
    this.jpegStop?.();
    this.jpegStop = null;
    this.jpegTimer = null;
    if (this.peerTimer) clearTimeout(this.peerTimer);
    for (const peer of this.peers.values()) peer.pc.close();
    this.peers.clear();
    this.socket?.close();
    if (this.snapshot.frameUrl) URL.revokeObjectURL(this.snapshot.frameUrl);
  }

  // ── Messages ─────────────────────────────────────────────────────────────

  private onMessage(message: AppStreamServerMessage) {
    switch (message.t) {
      case "hello":
        this.iceServers = message.iceServers;
        return this.set({ you: message.you });
      case "state":
        this.set({ state: message.state });
        if (this.role === "host") this.syncPeers(message.state);
        else this.maybeExpectHost(message.state);
        return;
      case "logs":
        return this.set({ log: message.entries });
      case "log":
        return this.set({ log: [...this.snapshot.log.slice(-199), message.entry] });
      case "cursor": {
        const next: AppStreamCursor = { ...message, atMs: Date.now() };
        return this.set({
          cursors: [...this.snapshot.cursors.filter((c) => c.key !== message.key), next],
        });
      }
      case "signal":
        return void this.onSignal(message.from, message.data as SignalData);
      case "input":
        return void this.applyInput(message.subject, message.ev);
      case "pong":
        return this.set({
          stats: { ...this.snapshot.stats, rttMs: Math.round(performance.now() - message.at) },
        });
      case "error":
        return this.set({ error: message.message });
    }
  }

  // ── Host ─────────────────────────────────────────────────────────────────

  async share(window_: DesktopShareableWindow, recipeId: string | null) {
    await this.stopSharing(false);
    // Nothing is brought to the front on its own: the host's screen is theirs. When Stage Manager
    // shows the shared window as a thumbnail, the host is asked ("Bring to front") instead.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: window_.sourceId,
          maxFrameRate: 60,
          maxWidth: 3840,
          maxHeight: 2160,
        },
      } as unknown as MediaTrackConstraints,
    });
    const track = stream.getVideoTracks()[0];
    if (track) track.contentHint = "detail";
    this.hostStream = stream;
    this.sharedWindowId = window_.windowId;
    const settings = track?.getSettings() ?? {};
    const app: Omit<AppStreamSharedApp, "sharedAtMs"> = {
      appName: window_.app,
      title: window_.title,
      sourceId: window_.sourceId,
      windowId: window_.windowId,
      width: settings.width ?? window_.width,
      height: settings.height ?? window_.height,
      recipeId,
    };
    this.send({ t: "share", app });
    this.set({ stream, sharing: { ...app, sharedAtMs: Date.now() } });
    await window.desktopBridge?.appShare?.arm(true);
    track?.addEventListener("ended", () => void this.stopSharing());
    // Peers for everyone already watching.
    if (this.snapshot.state) this.syncPeers(this.snapshot.state, true);
  }

  /** The host's capture track, for the benchmark's no-network baseline. */
  hostTrack(): MediaStreamTrack | null {
    return this.hostStream?.getVideoTracks()[0] ?? null;
  }

  /**
   * Moves the shared window onto a hidden display (or back). The host keeps their own screen:
   * viewers and agents work the app there, with input posted to the app alone, never the host's
   * cursor or keyboard. Limits: shortcuts that need the app frontmost and Open/Save panels.
   */
  async setHidden(on: boolean) {
    const windowId = this.sharedWindowId;
    if (windowId === null) return;
    const reply = (await window.desktopBridge?.appShare?.inject(windowId, {
      kind: "stage",
      on,
    })) as { ok: boolean; reason?: string; staged?: boolean } | undefined;
    this.set({
      hidden: reply?.ok === true && reply.staged === true,
      hiddenError: reply?.ok === false ? (reply.reason ?? "unavailable") : null,
    });
  }

  async stopSharing(notify = true) {
    this.updateJpeg(false);
    if (this.snapshot.hidden && this.sharedWindowId !== null) {
      await window.desktopBridge?.appShare?.inject(this.sharedWindowId, {
        kind: "stage",
        on: false,
      });
      this.set({ hidden: false });
    }
    if (this.hostStream) {
      for (const track of this.hostStream.getTracks()) track.stop();
      this.hostStream = null;
      if (notify) this.send({ t: "unshare" });
      await window.desktopBridge?.appShare?.arm(false);
    }
    for (const peer of this.peers.values()) peer.pc.close();
    this.peers.clear();
    this.sharedWindowId = null;
    this.set({ stream: null, sharing: null });
  }

  grant(subject: string, minutes: number) {
    this.send({ t: "grant", subject, minutes });
  }
  deny(subject: string) {
    this.send({ t: "deny", subject });
  }
  revoke(subject: string | "*") {
    this.send({ t: "revoke", subject });
  }
  /** Brings the shared window back to the front on the host. */
  focusShared() {
    if (this.sharedWindowId !== null) {
      void window.desktopBridge?.appShare?.inject(this.sharedWindowId, { kind: "focus" });
    }
  }
  /** The kill switch: every grant gone, any held button released. */
  kill() {
    this.send({ t: "kill" });
    void window.desktopBridge?.appShare?.arm(false).then(() => {
      if (this.hostStream) void window.desktopBridge?.appShare?.arm(true);
    });
  }

  private syncPeers(state: AppStreamState, force = false) {
    if (!this.hostStream) return;
    const viewers = state.people.filter((person) => person.role === "viewer");
    for (const [key, peer] of this.peers) {
      if (!viewers.some((viewer) => viewer.key === key)) {
        peer.pc.close();
        this.peers.delete(key);
      }
    }
    for (const viewer of viewers) {
      const known = this.peers.get(viewer.key);
      if (known && !force) {
        known.subject = viewer.subject;
        continue;
      }
      if (known) known.pc.close();
      void this.offerTo(viewer);
    }
    this.updateJpeg(viewers.some((viewer) => viewer.jpeg === true));
  }

  private makePeer(key: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: [...this.iceServers] as RTCIceServer[] });
    const peer: Peer = { pc, channel: null, subject: null };
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.send({ t: "signal", to: key, data: { candidate: event.candidate.toJSON() } });
      }
    };
    this.peers.set(key, peer);
    return peer;
  }

  private async offerTo(viewer: AppStreamPerson) {
    if (!this.hostStream) return;
    const peer = this.makePeer(viewer.key);
    peer.subject = viewer.subject;
    for (const track of this.hostStream.getTracks()) {
      const sender = peer.pc.addTrack(track, this.hostStream);
      const params = sender.getParameters();
      params.encodings = [{ ...params.encodings?.[0], maxBitrate: 12_000_000, maxFramerate: 60 }];
      params.degradationPreference = "maintain-framerate";
      void sender.setParameters(params).catch(() => undefined);
    }
    const channel = peer.pc.createDataChannel("input", { ordered: true });
    channel.onmessage = (event) => {
      const ev = JSON.parse(String(event.data)) as AppStreamInput;
      if (peer.subject) void this.applyInput(peer.subject, ev);
    };
    peer.channel = channel;
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.send({ t: "signal", to: viewer.key, data: { sdp: peer.pc.localDescription?.toJSON() } });
  }

  /** The host's own check: only people the host granted, only into the shared window. */
  private async applyInput(subject: string, ev: AppStreamInput) {
    if (this.role !== "host" || this.sharedWindowId === null) return;
    const grant = this.snapshot.state?.grants.find((candidate) => candidate.subject === subject);
    if (!grant || grant.expiresAtMs <= Date.now()) return;
    await window.desktopBridge?.appShare?.inject(this.sharedWindowId, ev);
  }

  private updateJpeg(on: boolean) {
    if (!on || !this.hostStream) {
      if (this.jpegTimer) clearInterval(this.jpegTimer);
      this.jpegTimer = null;
      this.jpegStop?.();
      this.jpegStop = null;
      return;
    }
    if (this.jpegTimer || this.jpegStop) return;
    const track = this.hostStream.getVideoTracks()[0];
    if (!track) return;
    const send = (blob: Blob | null) => {
      if (blob && this.socket?.readyState === WebSocket.OPEN) this.socket.send(blob);
    };
    // Newest frame wins: skip while the socket still holds the last one.
    const congested = () =>
      this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 512 * 1024;
    const Processor = (
      globalThis as unknown as {
        MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => {
          readable: ReadableStream<VideoFrame>;
        };
      }
    ).MediaStreamTrackProcessor;
    if (Processor) {
      // Reads frames straight off the capture, so it keeps going while the host window is in the
      // background (timers and video elements there are throttled). Capture only delivers frames
      // when pixels change, so the newest frame is kept and re-sent every second while nothing
      // moves: a viewer who just switched to JPEG sees the app at once.
      const clone = track.clone();
      const reader = new Processor({ track: clone }).readable.getReader();
      const canvas = new OffscreenCanvas(1, 1);
      let stopped = false;
      let latest: VideoFrame | null = null;
      let lastSentAt = 0;
      let busy = false;
      const encode = async () => {
        if (!latest || busy || congested()) return;
        busy = true;
        lastSentAt = performance.now();
        const frame = latest;
        const scale = Math.min(1, 1600 / frame.displayWidth);
        canvas.width = Math.round(frame.displayWidth * scale);
        canvas.height = Math.round(frame.displayHeight * scale);
        canvas.getContext("2d")?.drawImage(frame, 0, 0, canvas.width, canvas.height);
        try {
          send(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 }));
        } finally {
          busy = false;
        }
      };
      const pump = async () => {
        while (!stopped) {
          const { value: frame, done } = await reader.read();
          if (done || !frame) break;
          latest?.close();
          latest = frame;
          if (performance.now() - lastSentAt >= 1000 / JPEG_FPS) void encode();
        }
      };
      void pump().catch(() => undefined);
      // A still window may not have sent a frame since this started: seed one from a video element.
      const seed = document.createElement("video");
      seed.muted = true;
      seed.srcObject = new MediaStream([track]);
      void seed.play().catch(() => undefined);
      const idle = setInterval(() => {
        if (!latest && seed.videoWidth > 0) {
          try {
            latest = new VideoFrame(seed, { timestamp: 0 });
          } catch {
            // Not ready yet; next tick.
          }
        }
        if (performance.now() - lastSentAt > 1000) void encode();
      }, 250);
      this.jpegStop = () => {
        stopped = true;
        clearInterval(idle);
        seed.srcObject = null;
        void reader.cancel().catch(() => undefined);
        clone.stop();
        latest?.close();
        latest = null;
      };
      return;
    }
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = this.hostStream;
    void video.play();
    const canvas = document.createElement("canvas");
    let busy = false;
    this.jpegTimer = setInterval(() => {
      if (busy || video.videoWidth === 0 || congested()) return;
      const scale = Math.min(1, 1600 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      busy = true;
      canvas.toBlob(
        (blob) => {
          busy = false;
          send(blob);
        },
        "image/jpeg",
        0.72,
      );
    }, 1000 / JPEG_FPS);
  }

  // ── Viewer ───────────────────────────────────────────────────────────────

  private maybeExpectHost(state: AppStreamState) {
    if (!state.app || !state.host) {
      if (this.snapshot.stats.transport !== "connecting") {
        this.set({ stats: { ...emptyStats, transport: "connecting" }, stream: null });
      }
      return;
    }
    if (this.snapshot.stats.transport === "connecting" && this.peerTimer === null) {
      this.peerTimer = setTimeout(() => {
        this.peerTimer = null;
        if (this.snapshot.stats.transport !== "webrtc") this.useJpeg();
      }, PEER_TIMEOUT_MS);
    }
  }

  /** Forces the fallback, for people behind networks that block peer connections (and tests). */
  useJpeg() {
    for (const peer of this.peers.values()) peer.pc.close();
    this.peers.clear();
    this.send({ t: "jpeg", on: true });
    this.set({ stats: { ...this.snapshot.stats, transport: "jpeg" }, stream: null });
  }

  private async onSignal(from: string, data: SignalData) {
    if (this.role === "host") {
      const peer = this.peers.get(from);
      if (!peer) return;
      if (data.sdp) await peer.pc.setRemoteDescription(data.sdp);
      if (data.candidate) await peer.pc.addIceCandidate(data.candidate).catch(() => undefined);
      return;
    }
    if (this.snapshot.stats.transport === "jpeg") return;
    let peer = this.peers.get(from);
    if (data.sdp?.type === "offer") {
      peer?.pc.close();
      peer = this.makePeer(from);
      peer.pc.ontrack = (event) => {
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        this.set({ stream, stats: { ...this.snapshot.stats, transport: "webrtc" } });
      };
      peer.pc.ondatachannel = (event) => {
        peer!.channel = event.channel;
      };
      peer.pc.onconnectionstatechange = () => {
        if (peer!.pc.connectionState === "failed") this.useJpeg();
      };
      await peer.pc.setRemoteDescription(data.sdp);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.send({ t: "signal", to: from, data: { sdp: peer.pc.localDescription?.toJSON() } });
      return;
    }
    if (data.candidate && peer)
      await peer.pc.addIceCandidate(data.candidate).catch(() => undefined);
  }

  private onFrame(blob: Blob) {
    const previous = this.snapshot.frameUrl;
    const frameUrl = URL.createObjectURL(blob);
    this.set({ frameUrl });
    if (previous) setTimeout(() => URL.revokeObjectURL(previous), 1000);
    const now = performance.now();
    for (const listener of this.frameListeners) listener(now);
  }

  requestControl() {
    this.send({ t: "control.request" });
  }
  releaseControl() {
    this.send({ t: "control.release" });
  }

  /** A viewer's input: over the data channel when there is one, else through the server. */
  input(ev: AppStreamInput) {
    const channel = [...this.peers.values()].find(
      (peer) => peer.channel?.readyState === "open",
    )?.channel;
    if (channel) channel.send(JSON.stringify(ev));
    else this.send({ t: "input", ev });
  }

  cursor(x: number, y: number) {
    this.send({ t: "cursor", x, y });
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  private async collectStats() {
    const now = Date.now();
    const cursors = this.snapshot.cursors.filter((cursor) => now - cursor.atMs < 5000);
    if (cursors.length !== this.snapshot.cursors.length) this.set({ cursors });
    const peer = [...this.peers.values()].find(
      (candidate) => candidate.pc.connectionState === "connected",
    );
    if (!peer) return;
    const report = await peer.pc.getStats();
    let next: Partial<AppStreamStats> = {};
    const codecs = new Map<string, string>();
    report.forEach((entry: Record<string, unknown>) => {
      if (entry["type"] === "codec") codecs.set(String(entry["id"]), String(entry["mimeType"]));
    });
    report.forEach((entry: Record<string, unknown>) => {
      const kind = entry["kind"];
      if (kind !== "video") return;
      if (entry["type"] === "inbound-rtp" || entry["type"] === "outbound-rtp") {
        const bytes = Number(
          entry[entry["type"] === "inbound-rtp" ? "bytesReceived" : "bytesSent"] ?? 0,
        );
        const at = Number(entry["timestamp"] ?? now);
        const bitrate =
          this.lastBytes && at > this.lastBytes.at
            ? Math.round(((bytes - this.lastBytes.bytes) * 8) / (at - this.lastBytes.at))
            : null;
        this.lastBytes = { bytes, at };
        const decoded = Number(entry["framesDecoded"] ?? entry["framesEncoded"] ?? 0);
        const jitter = Number(entry["jitterBufferDelay"] ?? 0);
        const emitted = Number(entry["jitterBufferEmittedCount"] ?? 0);
        next = {
          fps: entry["framesPerSecond"] === undefined ? null : Number(entry["framesPerSecond"]),
          bitrateKbps: bitrate,
          framesDecoded: decoded,
          framesDropped:
            entry["framesDropped"] === undefined ? null : Number(entry["framesDropped"]),
          jitterBufferMs: emitted > 0 ? Math.round((jitter / emitted) * 1000) : null,
          codec: codecs.get(String(entry["codecId"])) ?? null,
          width: entry["frameWidth"] === undefined ? null : Number(entry["frameWidth"]),
          height: entry["frameHeight"] === undefined ? null : Number(entry["frameHeight"]),
        };
      }
    });
    this.set({ stats: { ...this.snapshot.stats, ...next } });
  }
}

interface SignalData {
  readonly sdp?: RTCSessionDescriptionInit;
  readonly candidate?: RTCIceCandidateInit;
}

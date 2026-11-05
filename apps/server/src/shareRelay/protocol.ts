// Wire format shared with infra/share-relay/src/protocol.ts (kept in sync by shareRelay.e2e tests):
//   binary message = u8 type | u32 stream id (big endian) | payload; control messages are JSON text.
export const T = {
  REQ_HEAD: 1,
  REQ_BODY: 2,
  REQ_END: 3,
  RES_HEAD: 4,
  RES_BODY: 5,
  RES_END: 6,
  ABORT: 7,
  UPG_REQ: 8,
  UPG_RES: 9,
  RAW: 10,
  RAW_END: 11,
  PAUSE: 12,
  RESUME: 13,
} as const;

export const encodeFrame = (type: number, streamId: number, payload?: Uint8Array | string | object): Uint8Array => {
  const body =
    payload === undefined
      ? new Uint8Array(0)
      : payload instanceof Uint8Array
        ? payload
        : new TextEncoder().encode(typeof payload === "string" ? payload : JSON.stringify(payload));
  const out = new Uint8Array(5 + body.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, type);
  view.setUint32(1, streamId >>> 0);
  out.set(body, 5);
  return out;
};

export interface Frame {
  readonly type: number;
  readonly id: number;
  readonly payload: Uint8Array;
}

export const decodeFrame = (data: ArrayBuffer | Uint8Array): Frame | null => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 5) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { type: view.getUint8(0), id: view.getUint32(1), payload: bytes.subarray(5) };
};

export const parseJsonBytes = (payload: Uint8Array): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(new TextDecoder().decode(payload));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

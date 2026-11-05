import { describe, expect, it } from "vite-plus/test";

import { selectNametag } from "./messageAuthors.logic";

const ann = { userId: "a", name: "Ann", color: 2 };
const host = { userId: null, name: "Host", color: 5 };

describe("selectNametag", () => {
  it("shows nothing for an unknown author", () => {
    expect(selectNametag({ authors: { m1: ann }, messageId: "m2", viewerUserId: "a" })).toBeNull();
  });
  it("keeps a solo thread clean", () => {
    expect(selectNametag({ authors: { m1: ann }, messageId: "m1", viewerUserId: "a" })).toBeNull();
    expect(selectNametag({ authors: { m1: host }, messageId: "m1", viewerUserId: null })).toBeNull();
  });
  it("tags someone else's message even in a solo-author thread", () => {
    expect(selectNametag({ authors: { m1: ann }, messageId: "m1", viewerUserId: null })).toEqual(ann);
  });
  it("tags the viewer's own message once two people posted", () => {
    const authors = { m1: ann, m2: host };
    expect(selectNametag({ authors, messageId: "m1", viewerUserId: "a" })).toEqual(ann);
    expect(selectNametag({ authors, messageId: "m2", viewerUserId: "a" })).toEqual(host);
  });
  it("does not guess before the viewer is known", () => {
    expect(selectNametag({ authors: { m1: ann }, messageId: "m1", viewerUserId: undefined })).toBeNull();
  });
});

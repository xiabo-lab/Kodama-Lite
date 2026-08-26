import { beforeEach, describe, expect, it } from "vitest";
import { coverSrc, pickThumbnail } from "@/components/shared/thumbnail";
import { useAppStore } from "@/store/appStore";

/**
 * The cold-boot artwork path.
 *
 * The bug these guard: the Pi's network arrives ~40s after the app does,
 * `homeStore` paints the last feed from localStorage on the first frame,
 * and every `<img>` pointed straight at YouTube's CDN failed — so a Home
 * screen with all the right titles showed nothing but grey placeholder
 * tiles for the first minute of a drive. Worse, the failure was sticky:
 * the carousel keys items by `kind:id`, so React kept the component
 * instances (and their memory of the failure) across the refresh that
 * eventually succeeded.
 */
describe("coverSrc", () => {
  const url = "https://i.ytimg.com/vi/abc/mqdefault.jpg";

  it("routes artwork through the local disk cache once the base is known", () => {
    expect(coverSrc(url, "http://127.0.0.1:5001/tok/cover")).toBe(
      `http://127.0.0.1:5001/tok/cover?u=${encodeURIComponent(url)}`,
    );
  });

  it("encodes the URL so query and fragment characters survive", () => {
    // Real googleusercontent artwork URLs carry `=w256-h256` and `?` params.
    const messy = "https://lh3.googleusercontent.com/x?a=1&b=2#frag";
    const src = coverSrc(messy, "http://127.0.0.1:1/t/cover");
    expect(src).toBe(`http://127.0.0.1:1/t/cover?u=${encodeURIComponent(messy)}`);
    // Decoding what we sent must give back exactly the original URL —
    // a bare `&` here would truncate the upstream URL server-side.
    expect(decodeURIComponent(new URL(src).searchParams.get("u") ?? "")).toBe(messy);
  });

  it("falls back to the upstream URL before cover:base answers", () => {
    // Degrading to "no cache" is correct; degrading to "no artwork" is not.
    expect(coverSrc(url, undefined)).toBe(url);
  });
});

describe("pickThumbnail", () => {
  it("takes the smallest variant that still meets the target", () => {
    const thumbs = [
      { url: "s", width: 60, height: 60 },
      { url: "m", width: 256, height: 256 },
      { url: "l", width: 800, height: 800 },
    ];
    expect(pickThumbnail(thumbs, 256)).toBe("m");
  });

  it("falls back to the largest when nothing meets the target", () => {
    const thumbs = [
      { url: "s", width: 60, height: 60 },
      { url: "m", width: 120, height: 120 },
    ];
    expect(pickThumbnail(thumbs, 256)).toBe("m");
  });

  it("has no URL to offer when the API shipped no artwork", () => {
    expect(pickThumbnail([], 256)).toBeNull();
  });
});

describe("appStore connectivity epoch", () => {
  beforeEach(() => {
    useAppStore.setState({ online: true, netChecked: false, netEpoch: 0 });
  });

  it("bumps only on the offline→online edge", () => {
    const { applyEvents } = useAppStore.getState();

    applyEvents([{ type: "net:status", online: false }]);
    expect(useAppStore.getState().netEpoch).toBe(0);

    applyEvents([{ type: "net:status", online: true }]);
    expect(useAppStore.getState().netEpoch).toBe(1);
  });

  it("does not bump while the network merely stays up", () => {
    const { applyEvents } = useAppStore.getState();
    // The background watcher probes every 20s. Re-testing every failed
    // image on each of those would be a retry storm, not a repair.
    applyEvents([{ type: "net:status", online: true }]);
    applyEvents([{ type: "net:status", online: true }]);
    expect(useAppStore.getState().netEpoch).toBe(0);
  });

  it("does not bump while the network stays down", () => {
    const { applyEvents } = useAppStore.getState();
    applyEvents([{ type: "net:status", online: false }]);
    applyEvents([{ type: "net:status", online: false }]);
    expect(useAppStore.getState().netEpoch).toBe(0);
  });

  it("records where covers are served from", () => {
    const { applyEvents } = useAppStore.getState();
    applyEvents([{ type: "cover:base", url: "http://127.0.0.1:9/t/cover" }]);
    expect(useAppStore.getState().coverBase).toBe("http://127.0.0.1:9/t/cover");
  });
});

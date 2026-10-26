import { describe, expect, it } from "vitest";
import { carouselDragThreshold } from "./shelf-carousel";

describe("carouselDragThreshold", () => {
  it("keeps mouse dragging precise", () => {
    expect(carouselDragThreshold("mouse")).toBe(5);
  });

  it("allows normal fingertip movement without cancelling a card tap", () => {
    expect(carouselDragThreshold("touch")).toBe(18);
    expect(carouselDragThreshold("pen")).toBe(18);
  });
});

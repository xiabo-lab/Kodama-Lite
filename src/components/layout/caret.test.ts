import { describe, expect, it } from "vitest";

/**
 * The caret arithmetic the on-screen keyboard performs, expressed as pure
 * functions so the interesting cases can be checked without a DOM.
 *
 * These mirror `insert` / `backspace` in `on-screen-keyboard.tsx`. The
 * behaviour they pin down is the point of the whole feature: before this,
 * text could only be appended to and truncated from the END, so correcting
 * "I Love You" to "You" meant deleting seven correct characters to reach
 * the wrong ones.
 */

function insertAt(text: string, pos: number, insert: string) {
  const i = Math.max(0, Math.min(pos, text.length));
  return { text: text.slice(0, i) + insert + text.slice(i), caret: i + insert.length };
}

function backspaceAt(text: string, pos: number) {
  const i = Math.max(0, Math.min(pos, text.length));
  if (i === 0) return { text, caret: 0 };
  return { text: text.slice(0, i - 1) + text.slice(i), caret: i - 1 };
}

function deleteAt(text: string, pos: number) {
  const i = Math.max(0, Math.min(pos, text.length));
  return { text: text.slice(0, i) + text.slice(i + 1), caret: i };
}

const clamp = (pos: number, len: number) => Math.max(0, Math.min(len, pos));

describe("insert", () => {
  it("inserts at the caret and leaves it after the insertion", () => {
    expect(insertAt("Iove You", 1, "L")).toEqual({ text: "ILove You", caret: 2 });
  });

  it("appends when the caret is at the end", () => {
    expect(insertAt("abc", 3, "d")).toEqual({ text: "abcd", caret: 4 });
  });

  it("prepends when the caret is at 0", () => {
    expect(insertAt("bc", 0, "a")).toEqual({ text: "abc", caret: 1 });
  });

  it("clamps a caret past the end", () => {
    expect(insertAt("ab", 99, "c")).toEqual({ text: "abc", caret: 3 });
  });

  it("inserts multi-character text (a Pinyin candidate) as one unit", () => {
    expect(insertAt("之间", 0, "一念")).toEqual({ text: "一念之间", caret: 2 });
  });
});

describe("backspace", () => {
  it("deletes the character to the LEFT of the caret", () => {
    // "I Love You" with the caret at 6 sits just after the "e" of "Love",
    // so backspace takes that "e" and nothing else.
    expect(backspaceAt("I Love You", 6)).toEqual({ text: "I Lov You", caret: 5 });
  });

  it("is a no-op at the start of the string", () => {
    expect(backspaceAt("abc", 0)).toEqual({ text: "abc", caret: 0 });
  });

  it("removes the last character when the caret is at the end", () => {
    expect(backspaceAt("abc", 3)).toEqual({ text: "ab", caret: 2 });
  });

  it("can strip a prefix without touching the suffix", () => {
    // The motivating example: turn "I Love You" into "You" by backspacing
    // with the caret placed after "Love ", never touching "You".
    let s = { text: "I Love You", caret: 7 };
    for (let i = 0; i < 7; i++) s = backspaceAt(s.text, s.caret);
    expect(s).toEqual({ text: "You", caret: 0 });
  });
});

describe("forward delete", () => {
  it("removes the character to the RIGHT and leaves the caret put", () => {
    expect(deleteAt("abc", 1)).toEqual({ text: "ac", caret: 1 });
  });

  it("is a no-op at the end", () => {
    expect(deleteAt("abc", 3)).toEqual({ text: "abc", caret: 3 });
  });
});

describe("caret clamping", () => {
  it("never escapes the string", () => {
    expect(clamp(-5, 3)).toBe(0);
    expect(clamp(99, 3)).toBe(3);
    expect(clamp(2, 3)).toBe(2);
  });

  it("re-clamps after the text shrinks under it", () => {
    // Switching fields or clearing leaves a stale index behind; the field
    // clamps on render so it can never point past the end.
    expect(clamp(10, "ab".length)).toBe(2);
  });
});

import { describe, it, expect } from "bun:test";
import { parseIpcError } from "../src/renderer/shared/ipcError";

describe("parseIpcError", () => {
  it("strips Electron's IPC wrapper and leading 'Error:'", () => {
    const wrapped = new Error(
      "Error invoking remote method 'backend:addLocalRepo': Error: something failed",
    );
    expect(parseIpcError(wrapped)).toEqual({
      context: null,
      message: "something failed",
      action: null,
    });
  });

  it("splits the `<context>\\n<reason>` convention used by addLocalRepo", () => {
    const err = new Error("/Users/fei/Aura\nThis repo's remote is on gitlab.com.");
    expect(parseIpcError(err)).toEqual({
      context: "/Users/fei/Aura",
      message: "This repo's remote is on gitlab.com.",
      action: null,
    });
  });

  it("extracts the no_access action marker and removes it from the message", () => {
    const err = new Error(
      "/Users/fei/Aura\n" +
        "Early-Days/Aura is owned by Early-Days, which isn't your GitHub account or one of your active orgs.\n" +
        "__action:no_access__",
    );
    const parsed = parseIpcError(err);
    expect(parsed.context).toBe("/Users/fei/Aura");
    expect(parsed.action).toBe("no_access");
    expect(parsed.message).not.toContain("__action:");
    expect(parsed.message).toContain("Early-Days");
  });

  it("handles a multi-line reason with a trailing action marker", () => {
    const err = new Error(
      "/p\n" +
        "line one\n" +
        "line two\n" +
        "line three\n" +
        "__action:no_access__",
    );
    const parsed = parseIpcError(err);
    expect(parsed.context).toBe("/p");
    expect(parsed.message).toBe("line one\nline two\nline three");
    expect(parsed.action).toBe("no_access");
  });

  it("ignores a marker-shaped middle line (only trailing line counts)", () => {
    const err = new Error("/p\n__action:no_access__\nactually the real reason");
    const parsed = parseIpcError(err);
    expect(parsed.action).toBeNull();
    expect(parsed.message).toBe("__action:no_access__\nactually the real reason");
  });

  it("returns message-only for single-line errors with no marker", () => {
    expect(parseIpcError(new Error("nope"))).toEqual({
      context: null,
      message: "nope",
      action: null,
    });
  });

  it("returns action-only when a single-line message is just a marker (defensive)", () => {
    const parsed = parseIpcError(new Error("__action:no_access__"));
    expect(parsed.action).toBe("no_access");
    expect(parsed.context).toBeNull();
    expect(parsed.message).toBe("");
  });

  it("accepts non-Error inputs", () => {
    expect(parseIpcError("plain string")).toEqual({
      context: null,
      message: "plain string",
      action: null,
    });
  });
});

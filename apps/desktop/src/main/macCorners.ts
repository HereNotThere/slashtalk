// Reshape a BrowserWindow's frame on macOS via Cocoa FFI (koffi, no native
// compile step). No-op on non-darwin platforms.
//
// Why this file exists: the rail window uses NSVisualEffectView for real frost
// (see `vibrancy` on the overlay BrowserWindow). Vibrancy is a sibling NSView
// of the webContents, so CSS `border-radius` cannot clip it — we have to set
// the radius natively on the content view's CALayer.
//
// With `transparent: false` the NSWindow paints an opaque background behind
// the rounded content view, so the area outside the pill reads as a white
// rectangle. We also flip the NSWindow to opaque=NO + clearColor so those
// pixels composite as transparent. `transparent: false` stays in Electron
// options because flipping it there disables vibrancy entirely.

import type { BrowserWindow } from "electron";
import koffi from "koffi";

// Lazy so importing the module on non-darwin is free.
interface Bindings {
  sel_registerName: (name: string) => bigint;
  objc_getClass: (name: string) => bigint;
  msgSend_pp: (obj: bigint, sel: bigint) => bigint;
  msgSend_pb: (obj: bigint, sel: bigint, arg: boolean) => void;
  msgSend_pd: (obj: bigint, sel: bigint, arg: number) => void;
  msgSend_ppp: (obj: bigint, sel: bigint, arg: bigint) => void;
  msgSend_pdd: (obj: bigint, sel: bigint, a: number, b: number) => bigint;
}

let bindings: Bindings | null = null;

function load(): Bindings | null {
  if (bindings) return bindings;
  if (process.platform !== "darwin") return null;

  const objc = koffi.load("/usr/lib/libobjc.dylib");
  // AppKit provides NSWindow/NSView/NSColor — loading it makes sure the
  // Objective-C runtime has the class metadata registered by the time we send
  // messages.
  koffi.load("/System/Library/Frameworks/AppKit.framework/AppKit");

  // One objc_msgSend binding per argument shape we need. koffi requires a
  // concrete signature per call because objc_msgSend is variadic at the ABI
  // level — using the wrong shape would corrupt the stack on arm64. Declaring
  // the same symbol multiple times is fine; each returns an independent
  // binding.
  bindings = {
    sel_registerName: objc.func("sel_registerName", "intptr_t", [
      "const char*",
    ]),
    objc_getClass: objc.func("objc_getClass", "intptr_t", ["const char*"]),
    msgSend_pp: objc.func("objc_msgSend", "intptr_t", ["intptr_t", "intptr_t"]),
    msgSend_pb: objc.func("objc_msgSend", "void", [
      "intptr_t",
      "intptr_t",
      "bool",
    ]),
    msgSend_pd: objc.func("objc_msgSend", "void", [
      "intptr_t",
      "intptr_t",
      "double",
    ]),
    msgSend_ppp: objc.func("objc_msgSend", "void", [
      "intptr_t",
      "intptr_t",
      "intptr_t",
    ]),
    msgSend_pdd: objc.func("objc_msgSend", "intptr_t", [
      "intptr_t",
      "intptr_t",
      "double",
      "double",
    ]),
  };
  return bindings;
}

function readPointer(buf: Buffer): bigint {
  // NSWindow* is a pointer-sized value; macOS Electron is 64-bit on both
  // x64 and arm64, so the handle buffer is 8 bytes little-endian.
  return buf.readBigUInt64LE(0);
}

export interface MacBorder {
  /** Stroke width in points. Use 1 for a visible hairline on Retina. */
  width: number;
  /** White value 0–1. */
  white: number;
  /** Alpha 0–1. */
  alpha: number;
}

export function setMacCornerRadius(
  win: BrowserWindow,
  radius: number,
  border?: MacBorder,
): void {
  const b = load();
  if (!b) return;

  // Electron's getNativeWindowHandle returns NSView* (the content view itself),
  // not NSWindow*. Sending `contentView` to it would crash with
  // `unrecognized selector sent to instance`.
  const contentView = readPointer(win.getNativeWindowHandle());

  // Make the NSWindow's non-pill corners composite as transparent. Without
  // this, with `transparent: false`, the window paints its default window
  // backgroundColor (white in light mode) outside the rounded content view.
  const nsWindow = b.msgSend_pp(contentView, b.sel_registerName("window"));
  if (nsWindow) {
    b.msgSend_pb(nsWindow, b.sel_registerName("setOpaque:"), false);
    const nsColor = b.objc_getClass("NSColor");
    const clearColor = b.msgSend_pp(nsColor, b.sel_registerName("clearColor"));
    b.msgSend_ppp(
      nsWindow,
      b.sel_registerName("setBackgroundColor:"),
      clearColor,
    );
  }

  b.msgSend_pb(contentView, b.sel_registerName("setWantsLayer:"), true);
  const layer = b.msgSend_pp(contentView, b.sel_registerName("layer"));
  b.msgSend_pd(layer, b.sel_registerName("setCornerRadius:"), radius);
  b.msgSend_pb(layer, b.sel_registerName("setMasksToBounds:"), true);

  // System shadow (hasShadow:true) is cached against the original
  // rectangular alpha mask; invalidate so macOS recomputes it against our
  // rounded pill.
  if (nsWindow) {
    b.msgSend_pp(nsWindow, b.sel_registerName("invalidateShadow"));
  }

  if (border) {
    const nsColor = b.objc_getClass("NSColor");
    // +[NSColor colorWithWhite:alpha:] returns an autoreleased NSColor*. Its
    // CGColor is owned by the NSColor; CALayer retains the CGColor in
    // setBorderColor:, so the stroke survives the NSColor's autorelease.
    const strokeNs = b.msgSend_pdd(
      nsColor,
      b.sel_registerName("colorWithWhite:alpha:"),
      border.white,
      border.alpha,
    );
    const strokeCg = b.msgSend_pp(strokeNs, b.sel_registerName("CGColor"));
    b.msgSend_ppp(layer, b.sel_registerName("setBorderColor:"), strokeCg);
    b.msgSend_pd(layer, b.sel_registerName("setBorderWidth:"), border.width);
  }
}

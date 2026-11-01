/**
 * `lp-appctl`, the macOS helper that lists app windows and injects a granted
 * viewer's mouse and keyboard into ONE shared window. Kept as a string so the
 * desktop main process can compile it (swiftc) into its user data on first use
 * in development; release builds ship the compiled binary in Resources
 * (scripts/build-appctl.mjs).
 *
 * Protocol: one JSON object per line on stdin, one reply per line on stdout.
 *   {"id":1,"cmd":"trust","prompt":false}           -> {"id":1,"ok":true,"trusted":true}
 *   {"id":2,"cmd":"windows"}                        -> {"id":2,"ok":true,"windows":[...]}
 *   {"id":3,"cmd":"input","windowId":N,"ev":{...}}  -> {"id":3,"ok":true} or ok:false + reason
 *   ev {"kind":"focus"} brings the window to the front (the host does this when sharing starts).
 * Mouse events land only inside the window's bounds and only when that window
 * is the frontmost one at the point (it is brought forward once if covered).
 * Key events go to the window's process only (CGEventPostToPid).
 */
export const APPCTL_SWIFT_SOURCE = String.raw`
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

struct Win { let id: Int; let pid: Int32; let app: String; let title: String; let bounds: CGRect; let layer: Int; let alpha: Double }

func windows(only one: CGWindowID? = nil) -> [Win] {
  let options: CGWindowListOption = one == nil ? [.optionOnScreenOnly, .excludeDesktopElements] : [.optionIncludingWindow]
  guard let list = CGWindowListCopyWindowInfo(options, one ?? kCGNullWindowID) as? [[String: Any]] else { return [] }
  return list.compactMap { w in
    guard let id = w[kCGWindowNumber as String] as? Int,
          let pid = w[kCGWindowOwnerPID as String] as? Int32,
          let b = w[kCGWindowBounds as String] as? [String: Any],
          let rect = CGRect(dictionaryRepresentation: b as CFDictionary) else { return nil }
    return Win(id: id, pid: pid, app: (w[kCGWindowOwnerName as String] as? String) ?? "",
               title: (w[kCGWindowName as String] as? String) ?? "", bounds: rect,
               layer: (w[kCGWindowLayer as String] as? Int) ?? 0, alpha: (w[kCGWindowAlpha as String] as? Double) ?? 1)
  }
}

func reply(_ id: Any?, _ body: [String: Any]) {
  var out = body
  out["id"] = id ?? NSNull()
  if let data = try? JSONSerialization.data(withJSONObject: out), let s = String(data: data, encoding: .utf8) {
    print(s)
  }
}

let keyCodes: [String: CGKeyCode] = [
  "KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5, "KeyZ": 6, "KeyX": 7, "KeyC": 8, "KeyV": 9,
  "KeyB": 11, "KeyQ": 12, "KeyW": 13, "KeyE": 14, "KeyR": 15, "KeyY": 16, "KeyT": 17, "Digit1": 18, "Digit2": 19,
  "Digit3": 20, "Digit4": 21, "Digit6": 22, "Digit5": 23, "Equal": 24, "Digit9": 25, "Digit7": 26, "Minus": 27,
  "Digit8": 28, "Digit0": 29, "BracketRight": 30, "KeyO": 31, "KeyU": 32, "BracketLeft": 33, "KeyI": 34, "KeyP": 35,
  "Enter": 36, "KeyL": 37, "KeyJ": 38, "Quote": 39, "KeyK": 40, "Semicolon": 41, "Backslash": 42, "Comma": 43,
  "Slash": 44, "KeyN": 45, "KeyM": 46, "Period": 47, "Tab": 48, "Space": 49, "Backquote": 50, "Backspace": 51,
  "Escape": 53, "MetaRight": 54, "MetaLeft": 55, "ShiftLeft": 56, "CapsLock": 57, "AltLeft": 58, "ControlLeft": 59,
  "ShiftRight": 60, "AltRight": 61, "ControlRight": 62, "NumpadDecimal": 65, "NumpadMultiply": 67, "NumpadAdd": 69,
  "NumpadDivide": 75, "NumpadEnter": 76, "NumpadSubtract": 78, "Numpad0": 82, "Numpad1": 83, "Numpad2": 84,
  "Numpad3": 85, "Numpad4": 86, "Numpad5": 87, "Numpad6": 88, "Numpad7": 89, "Numpad8": 91, "Numpad9": 92,
  "F5": 96, "F6": 97, "F7": 98, "F3": 99, "F8": 100, "F9": 101, "F11": 103, "F10": 109, "F12": 111, "Home": 115,
  "PageUp": 116, "Delete": 117, "F4": 118, "End": 119, "F2": 120, "PageDown": 121, "F1": 122, "ArrowLeft": 123,
  "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
]

var buttonDown: [Int: Bool] = [0: false, 1: false, 2: false]
var lastFront: Int32 = 0
/** Where the viewer's pointer last was in each window (0..1), so keys after a refocus land under it. */
var lastNorm: [Int: CGPoint] = [:]
var lastActivation: [Int: Date] = [:]

/** The frontmost normal window under a point, skipping invisible overlays. */
func topWindow(at p: CGPoint, in list: [Win]) -> Win? {
  return list.first { $0.layer == 0 && $0.alpha > 0.01 && $0.bounds.width > 40 && $0.bounds.height > 40 && $0.bounds.contains(p) && $0.app != "WindowManager" }
}

func activate(_ pid: Int32) {
  NSRunningApplication(processIdentifier: pid)?.activate(options: [])
  lastFront = pid
}

func at(_ win: Win, _ n: CGPoint) -> CGPoint {
  return CGPoint(x: win.bounds.minX + n.x * win.bounds.width, y: win.bounds.minY + n.y * win.bounds.height)
}

/**
 * Brings the shared window forward (at most once a second per window, so a viewer cannot make the
 * host's screen flicker) and returns it with fresh bounds: Stage Manager and Spaces resize and move
 * windows that are not in front.
 */
func bringForward(_ win: Win) -> Win? {
  if let last = lastActivation[win.id], Date().timeIntervalSince(last) < 1 { return nil }
  lastActivation[win.id] = Date()
  activate(win.pid)
  for _ in 0..<10 {
    usleep(60_000)
    if let fresh = windows().first(where: { $0.id == win.id }), topWindow(at: CGPoint(x: fresh.bounds.midX, y: fresh.bounds.midY), in: windows())?.id == win.id {
      return fresh
    }
  }
  return windows().first(where: { $0.id == win.id })
}


// ── Hidden display ("stage") ─────────────────────────────────────────────────
// Ported from DeskBoard's StageCore (our code): a CGVirtualDisplay nobody can see, placed corner-only off the
// bottom-right of the real screens, with a fresh random identity every time (a fixed identity once re-applied a
// saved MIRROR layout). A 60 Hz fence throws the real cursor back if it ever reaches the stage. A shared window
// is moved there (AX) and stays visible on it, so capture keeps streaming while the host's own screen is untouched.
// Input to a staged window is posted to its pid only, stamped with the window number and window-local point
// (SkyLight SLEventSetWindowLocation): no activation, no cursor movement.

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)
typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
let slSetWindowLocation: SetWindowLocation? = skyLight.flatMap { dlsym($0, "SLEventSetWindowLocation") }.map { unsafeBitCast($0, to: SetWindowLocation.self) }

var stageObject: NSObject?
var stageId: CGDirectDisplayID = 0
var fenceTimer: Timer?
struct Staged { let pid: pid_t; let original: CGRect; let element: AXUIElement }
var staged: [Int: Staged] = [:]

func realDisplays() -> [CGRect] {
  var ids = [CGDirectDisplayID](repeating: 0, count: 16); var n: UInt32 = 0
  CGGetActiveDisplayList(16, &ids, &n)
  return ids.prefix(Int(n)).filter { $0 != stageId || stageObject == nil }.map { CGDisplayBounds($0) }
}
func stageBounds() -> CGRect? { stageObject == nil ? nil : CGDisplayBounds(stageId) }

// Exact ObjC ownership for the private classes: alloc returns +1, init consumes it and returns +1.
typealias AllocIMP = @convention(c) (AnyClass, Selector) -> UnsafeMutableRawPointer?
typealias InitDescIMP = @convention(c) (UnsafeMutableRawPointer, Selector, AnyObject) -> UnsafeMutableRawPointer?
typealias InitModeIMP = @convention(c) (UnsafeMutableRawPointer, Selector, UInt32, UInt32, Double) -> UnsafeMutableRawPointer?
func allocRaw(_ cls: AnyClass) -> UnsafeMutableRawPointer? {
  let sel = NSSelectorFromString("alloc")
  guard let m = class_getClassMethod(cls, sel) else { return nil }
  return unsafeBitCast(method_getImplementation(m), to: AllocIMP.self)(cls, sel)
}
func newDisplay(_ cls: AnyClass, _ desc: AnyObject) -> NSObject? {
  let sel = NSSelectorFromString("initWithDescriptor:")
  guard let raw = allocRaw(cls), let m = class_getInstanceMethod(cls, sel),
        let out = unsafeBitCast(method_getImplementation(m), to: InitDescIMP.self)(raw, sel, desc) else { return nil }
  return Unmanaged<NSObject>.fromOpaque(out).takeRetainedValue()
}
func newMode(_ cls: AnyClass, _ w: UInt32, _ h: UInt32, _ hz: Double) -> NSObject? {
  let sel = NSSelectorFromString("initWithWidth:height:refreshRate:")
  guard let raw = allocRaw(cls), let m = class_getInstanceMethod(cls, sel),
        let out = unsafeBitCast(method_getImplementation(m), to: InitModeIMP.self)(raw, sel, w, h, hz) else { return nil }
  return Unmanaged<NSObject>.fromOpaque(out).takeRetainedValue()
}
func callBool(_ obj: AnyObject, _ selName: String, _ arg: AnyObject) -> Bool {
  let sel = NSSelectorFromString(selName)
  guard let m = class_getInstanceMethod(type(of: obj), sel) else { return false }
  typealias F = @convention(c) (AnyObject, Selector, AnyObject) -> Bool
  return unsafeBitCast(method_getImplementation(m), to: F.self)(obj, sel, arg)
}

/** The user's own screen arrangement (origins of the real displays), taken before the stage exists. */
var arrangement: [CGDirectDisplayID: CGPoint] = [:]

func realDisplayOrigins() -> [CGDirectDisplayID: CGPoint] {
  var ids = [CGDirectDisplayID](repeating: 0, count: 16); var n: UInt32 = 0
  CGGetActiveDisplayList(16, &ids, &n)
  var out: [CGDirectDisplayID: CGPoint] = [:]
  for id in ids.prefix(Int(n)) where id != stageId || stageObject == nil {
    out[id] = CGDisplayBounds(id).origin
  }
  return out
}

/**
 * Adding or removing a display can make macOS rearrange the real ones (a laptop screen once ended up touching
 * its external monitor only at a corner). Put every real display back where the snapshot had it.
 * Returns how many displays had moved.
 */
@discardableResult
func restoreArrangement(_ option: CGConfigureOption = .forSession) -> Int {
  guard !arrangement.isEmpty else { return 0 }
  let now = realDisplayOrigins()
  let moved = arrangement.filter { id, origin in
    guard let current = now[id] else { return false }
    return abs(current.x - origin.x) >= 1 || abs(current.y - origin.y) >= 1
  }
  guard !moved.isEmpty else { return 0 }
  var cfg: CGDisplayConfigRef?
  guard CGBeginDisplayConfiguration(&cfg) == .success, let cfg else { return moved.count }
  for (id, origin) in arrangement where now[id] != nil {
    CGConfigureDisplayOrigin(cfg, id, Int32(origin.x), Int32(origin.y))
  }
  if CGCompleteDisplayConfiguration(cfg, option) != .success { CGCancelDisplayConfiguration(cfg) }
  FileHandle.standardError.write("lp-appctl: restored \(moved.count) display(s) to the user's arrangement\n".data(using: .utf8)!)
  return moved.count
}

/** Creates the stage (async: this process sees the display only after its run loop turns), then places it. */
func createStage(_ done: @escaping (String?) -> Void) {
  if stageObject != nil { return done(nil) }
  arrangement = realDisplayOrigins()
  guard let descCls = NSClassFromString("CGVirtualDisplayDescriptor") as? NSObject.Type,
        let setCls = NSClassFromString("CGVirtualDisplaySettings") as? NSObject.Type,
        let modeCls = NSClassFromString("CGVirtualDisplayMode"), let dispCls = NSClassFromString("CGVirtualDisplay") else {
    return done("CGVirtualDisplay is not available on this macOS")
  }
  var vendor: UInt32 = 0, product: UInt32 = 0
  repeat { vendor = UInt32.random(in: 0x1000...0xFFFE) } while vendor == 0xD5B0
  repeat { product = UInt32.random(in: 0x1000...0xFFFE) } while product == 0xD5B0
  let serial = UInt32.random(in: 0x10000...0x7FFFFFFF)
  let w: UInt32 = 1920, h: UInt32 = 1200
  let desc = descCls.init()
  desc.setValue(DispatchQueue.main, forKey: "queue")
  desc.setValue(String(format: "LogicPacks hidden display %08x", serial), forKey: "name")
  desc.setValue(NSValue(point: NSPoint(x: 0.3127, y: 0.3290)), forKey: "whitePoint")
  desc.setValue(NSValue(point: NSPoint(x: 0.15, y: 0.06)), forKey: "bluePrimary")
  desc.setValue(NSValue(point: NSPoint(x: 0.30, y: 0.60)), forKey: "greenPrimary")
  desc.setValue(NSValue(point: NSPoint(x: 0.64, y: 0.33)), forKey: "redPrimary")
  desc.setValue(NSNumber(value: w), forKey: "maxPixelsWide")
  desc.setValue(NSNumber(value: h), forKey: "maxPixelsHigh")
  desc.setValue(NSValue(size: NSSize(width: Double(w) / 4, height: Double(h) / 4)), forKey: "sizeInMillimeters")
  desc.setValue(NSNumber(value: serial), forKey: "serialNum")
  desc.setValue(NSNumber(value: product), forKey: "productID")
  desc.setValue(NSNumber(value: vendor), forKey: "vendorID")
  let terminated: @convention(block) (AnyObject?, AnyObject?) -> Void = { _, _ in }
  desc.setValue(terminated, forKey: "terminationHandler")
  guard let disp = newDisplay(dispCls, desc) else {
    return done("initWithDescriptor failed")
  }
  let settings = setCls.init()
  settings.setValue(NSNumber(value: 0), forKey: "hiDPI")
  guard let mode = newMode(modeCls, w, h, 60) else { return done("display mode failed") }
  settings.setValue([mode], forKey: "modes")
  guard callBool(disp, "applySettings:", settings) else { return done("applySettings failed") }
  stageObject = disp
  stageId = (disp.value(forKey: "displayID") as? NSNumber)?.uint32Value ?? 0
  let deadline = Date().addingTimeInterval(3)
  func tick() {
    if CGDisplayIsActive(stageId) == 1, !CGDisplayBounds(stageId).isEmpty {
      if let why = stageUnsafe() { destroyStage(); return done(why) }
      restoreArrangement()
      return placeStage {
        restoreArrangement()
        if let why = stageUnsafe() { destroyStage(); done(why); return }
        startFence()
        // macOS can still be settling the new layout: check the user's screens again shortly after.
        for delay in [0.5, 1.5, 3.0] {
          DispatchQueue.main.asyncAfter(deadline: .now() + delay) { if stageObject != nil { restoreArrangement() } }
        }
        done(nil)
      }
    }
    if Date() >= deadline { destroyStage(); return done("the hidden display never became active") }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { tick() }
  }
  tick()
}

/** Only a mirror is unsafe (it would show the host's screen there, or the stage on the host's screen). */
func stageUnsafe() -> String? {
  if CGDisplayIsActive(stageId) != 1 { return "hidden display is not active" }
  if CGDisplayIsInMirrorSet(stageId) == 1 { return "hidden display joined a mirror set" }
  if CGDisplayMirrorsDisplay(CGMainDisplayID()) == stageId { return "main display mirrors the hidden display" }
  return nil
}

/** True when b overlaps a real screen or shares part of an edge with one (a corner point alone is fine). */
func sharesEdge(_ b: CGRect, _ real: [CGRect]) -> Bool {
  guard !b.isEmpty else { return false }
  return real.contains { r in
    if r.intersects(b), !r.intersection(b).isEmpty { return true }
    let xOverlap = min(r.maxX, b.maxX) - max(r.minX, b.minX) > 0
    let yOverlap = min(r.maxY, b.maxY) - max(r.minY, b.minY) > 0
    let touchesX = abs(r.maxX - b.minX) < 1 || abs(b.maxX - r.minX) < 1
    let touchesY = abs(r.maxY - b.minY) < 1 || abs(b.maxY - r.minY) < 1
    return (touchesX && yOverlap) || (touchesY && xOverlap)
  }
}

/** Diagonally off the bottom-right corner of the user's screens (StageCore's order), judged on the snapshot. */
func placeStage(_ done: @escaping () -> Void) {
  let real = arrangement.map { CGRect(origin: $0.value, size: CGDisplayBounds($0.key).size) }
  guard let union = real.dropFirst().reduce(real.first, { $0?.union($1) }) else { return done() }
  let size = CGDisplayBounds(stageId).size
  let candidates = [CGPoint(x: union.maxX, y: union.maxY), CGPoint(x: union.maxX - size.width / 4, y: union.maxY),
                    CGPoint(x: union.maxX, y: union.maxY - size.height / 4), CGPoint(x: union.maxX, y: union.minY)]
  func attempt(_ i: Int) {
    guard i < candidates.count else { return done() }
    let o = candidates[i]
    var cfg: CGDisplayConfigRef?
    if CGBeginDisplayConfiguration(&cfg) == .success, let cfg {
      if CGConfigureDisplayOrigin(cfg, stageId, Int32(o.x), Int32(o.y)) == .success {
        CGCompleteDisplayConfiguration(cfg, .forSession)
      } else { CGCancelDisplayConfiguration(cfg) }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
      // The window server may nudge the origin; what matters is that no edge touches a real screen.
      let b = CGDisplayBounds(stageId)
      if (abs(b.minX - o.x) < 2 && abs(b.minY - o.y) < 2) || !sharesEdge(b, real) { done() } else { attempt(i + 1) }
    }
  }
  attempt(0)
}

func startFence() {
  guard fenceTimer == nil else { return }
  fenceTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { _ in
    guard let stage = stageBounds(), !stage.isEmpty else { return }
    let mainHeight = CGDisplayBounds(CGMainDisplayID()).height
    let m = NSEvent.mouseLocation
    let p = CGPoint(x: m.x, y: mainHeight - m.y)
    guard stage.contains(p) else { return }
    var best: (CGPoint, CGFloat)?
    for r in realDisplays() where !r.isEmpty {
      let q = CGPoint(x: min(max(p.x, r.minX + 2), r.maxX - 2), y: min(max(p.y, r.minY + 2), r.maxY - 2))
      let d = hypot(q.x - p.x, q.y - p.y)
      if best == nil || d < best!.1 { best = (q, d) }
    }
    if let t = best?.0 { CGWarpMouseCursorPosition(t); CGAssociateMouseAndMouseCursorPosition(1) }
  }
}

func destroyStage() {
  fenceTimer?.invalidate(); fenceTimer = nil
  stageObject = nil
  stageId = 0
  // Removing a display can rearrange the real ones too.
  DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { if stageObject == nil { restoreArrangement() } }
}

func axWindow(pid: pid_t, windowId: Int) -> AXUIElement? {
  let app = AXUIElementCreateApplication(pid)
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
        let list = value as? [AXUIElement] else { return nil }
  return list.first { element in
    var wid: CGWindowID = 0
    return _AXUIElementGetWindow(element, &wid) == .success && Int(wid) == windowId
  }
}
func setFrame(_ element: AXUIElement, _ r: CGRect) {
  var origin = r.origin, size = r.size
  if let p = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, p) }
  if let s = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, s) }
  if let p = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, p) }
}

/** Moves the shared window onto the hidden display (creating it), or back where it was. */
func stageWindow(_ id: Any?, _ win: Win, _ on: Bool) {
  if !on {
    if let s = staged.removeValue(forKey: win.id) { setFrame(s.element, s.original) }
    // The hidden display stays for later shares (each add or remove of a display risks macOS rearranging the
    // user's screens, and one process cannot bring up a second one); it goes when the app quits.
    return reply(id, ["ok": true, "staged": false])
  }
  if staged[win.id] != nil { return reply(id, ["ok": true, "staged": true]) }
  guard let element = axWindow(pid: win.pid, windowId: win.id) else { return reply(id, ["ok": false, "reason": "no_ax_window"]) }
  createStage { err in
    if let err { return reply(id, ["ok": false, "reason": err]) }
    let stage = CGDisplayBounds(stageId)
    let w = min(win.bounds.width, stage.width - 40), h = min(win.bounds.height, stage.height - 60)
    staged[win.id] = Staged(pid: win.pid, original: win.bounds, element: element)
    setFrame(element, CGRect(x: stage.minX + 20, y: stage.minY + 40, width: w, height: h))
    // One pid-posted click on the title bar gives the window key status there, for keystrokes.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
      if let fresh = windows().first(where: { $0.id == win.id }) {
        postStaged(fresh, .leftMouseDown, CGPoint(x: fresh.bounds.midX, y: fresh.bounds.minY + 12), .left)
        postStaged(fresh, .leftMouseUp, CGPoint(x: fresh.bounds.midX, y: fresh.bounds.minY + 12), .left)
      }
      reply(id, ["ok": true, "staged": true, "stage": [Double(stage.minX), Double(stage.minY), Double(stage.width), Double(stage.height)]])
    }
  }
}

/** One mouse event to a staged window's pid, routed by window number and window-local point. */
func postStaged(_ win: Win, _ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton) {
  guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
  if type != .mouseMoved { e.setIntegerValueField(.mouseEventClickState, value: 1) }
  e.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(win.id))
  slSetWindowLocation?(e, CGPoint(x: p.x - win.bounds.minX, y: p.y - win.bounds.minY))
  e.postToPid(win.pid)
}

func restoreAllAndExit() {
  fflush(stdout)
  for (_, s) in staged { setFrame(s.element, s.original) }
  staged.removeAll()
  guard stageObject != nil else { exit(0) }
  let gone = stageId
  destroyStage()
  // Wait (at most 3 s) for the display to go, then put the user's screens back if macOS moved them.
  let deadline = Date().addingTimeInterval(3)
  func tick() {
    if CGDisplayIsActive(gone) != 1 || Date() >= deadline {
      restoreArrangement()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { restoreArrangement(); exit(0) }
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { tick() }
  }
  tick()
}

/** Input for a window on the hidden display: pid-posted only, nothing activated, the real cursor never moves. */
func handleStagedInput(_ id: Any?, _ win: Win, _ kind: String, _ ev: [String: Any]) {
  if kind == "focus" { return reply(id, ["ok": true]) }
  if kind == "key" {
    guard let code = ev["code"] as? String, let key = keyCodes[code],
          let e = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: ev["down"] as? Bool ?? true) else {
      return reply(id, ["ok": false, "reason": "unknown_key"])
    }
    var flags: CGEventFlags = []
    if ev["shift"] as? Bool == true { flags.insert(.maskShift) }
    if ev["ctrl"] as? Bool == true { flags.insert(.maskControl) }
    if ev["alt"] as? Bool == true { flags.insert(.maskAlternate) }
    if ev["meta"] as? Bool == true { flags.insert(.maskCommand) }
    e.flags = flags
    e.postToPid(win.pid)
    return reply(id, ["ok": true])
  }
  let n = CGPoint(x: min(1, max(0, (ev["x"] as? Double) ?? 0)), y: min(1, max(0, (ev["y"] as? Double) ?? 0)))
  let p = at(win, n)
  let button = (ev["button"] as? Int) ?? 0
  let cg: CGMouseButton = button == 2 ? .right : button == 1 ? .center : .left
  switch kind {
  case "down":
    buttonDown[button] = true
    postStaged(win, button == 2 ? .rightMouseDown : button == 1 ? .otherMouseDown : .leftMouseDown, p, cg)
  case "up":
    buttonDown[button] = false
    postStaged(win, button == 2 ? .rightMouseUp : button == 1 ? .otherMouseUp : .leftMouseUp, p, cg)
  case "move":
    let type: CGEventType = buttonDown[0] == true ? .leftMouseDragged : buttonDown[2] == true ? .rightMouseDragged : buttonDown[1] == true ? .otherMouseDragged : .mouseMoved
    postStaged(win, type, p, buttonDown[2] == true ? .right : buttonDown[1] == true ? .center : .left)
  case "scroll":
    guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                          wheel1: Int32(-((ev["dy"] as? Double) ?? 0)), wheel2: Int32(-((ev["dx"] as? Double) ?? 0)), wheel3: 0) else { break }
    e.location = p
    e.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(win.id))
    slSetWindowLocation?(e, CGPoint(x: p.x - win.bounds.minX, y: p.y - win.bounds.minY))
    e.postToPid(win.pid)
  default:
    return reply(id, ["ok": false, "reason": "unknown_kind"])
  }
  reply(id, ["ok": true, "staged": true])
}

func handleInput(_ id: Any?, _ windowId: Int, _ ev: [String: Any]) {
  let list = windows()
  // A window Stage Manager has set aside is not on screen but still there (and still shareable to the stage).
  guard var win = list.first(where: { $0.id == windowId }) ?? windows(only: CGWindowID(max(0, windowId))).first(where: { $0.id == windowId }) else {
    return reply(id, ["ok": false, "reason": "window_gone"])
  }
  let kind = ev["kind"] as? String ?? ""
  if kind == "stage" { return stageWindow(id, win, ev["on"] as? Bool ?? true) }
  if staged[windowId] != nil { return handleStagedInput(id, win, kind, ev) }
  if kind == "focus" {
    // The host, when it starts sharing: windows in Stage Manager's strip are captured as thumbnails.
    lastActivation.removeValue(forKey: windowId)
    _ = bringForward(win)
    return reply(id, ["ok": true])
  }
  if kind == "key" {
    guard let code = ev["code"] as? String, let key = keyCodes[code] else { return reply(id, ["ok": false, "reason": "unknown_key"]) }
    let down = ev["down"] as? Bool ?? true
    guard let e = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: down) else { return reply(id, ["ok": false, "reason": "event"]) }
    var flags: CGEventFlags = []
    if ev["shift"] as? Bool == true { flags.insert(.maskShift) }
    if ev["ctrl"] as? Bool == true { flags.insert(.maskControl) }
    if ev["alt"] as? Bool == true { flags.insert(.maskAlternate) }
    if ev["meta"] as? Bool == true { flags.insert(.maskCommand) }
    e.flags = flags
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != win.pid {
      // Bring the app forward first, or the first key is lost; then put the pointer back where the
      // viewer had it (apps such as Blender route keys to the area under the pointer).
      if let fresh = bringForward(win), let n = lastNorm[windowId] {
        let p = at(fresh, n)
        if topWindow(at: p, in: windows())?.id == windowId {
          CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
          usleep(30_000)
        }
      }
    }
    e.postToPid(win.pid)
    return reply(id, ["ok": true])
  }
  let n = CGPoint(x: min(1, max(0, (ev["x"] as? Double) ?? 0)), y: min(1, max(0, (ev["y"] as? Double) ?? 0)))
  lastNorm[windowId] = n
  var p = at(win, n)
  if topWindow(at: p, in: list)?.id != windowId {
    guard let fresh = bringForward(win) else { return reply(id, ["ok": false, "reason": "covered"]) }
    win = fresh
    p = at(win, n)
    if topWindow(at: p, in: windows())?.id != windowId { return reply(id, ["ok": false, "reason": "covered"]) }
  }
  let button = (ev["button"] as? Int) ?? 0
  let cgButton: CGMouseButton = button == 2 ? .right : button == 1 ? .center : .left
  var type: CGEventType
  switch kind {
  case "down":
    type = button == 2 ? .rightMouseDown : button == 1 ? .otherMouseDown : .leftMouseDown
    buttonDown[button] = true
  case "up":
    type = button == 2 ? .rightMouseUp : button == 1 ? .otherMouseUp : .leftMouseUp
    buttonDown[button] = false
  case "move":
    type = buttonDown[0] == true ? .leftMouseDragged : buttonDown[2] == true ? .rightMouseDragged : buttonDown[1] == true ? .otherMouseDragged : .mouseMoved
  case "scroll":
    let dy = Int32(-((ev["dy"] as? Double) ?? 0)), dx = Int32(-((ev["dx"] as? Double) ?? 0))
    CGWarpMouseCursorPosition(p)
    if let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
      e.location = p
      e.post(tap: .cghidEventTap)
    }
    return reply(id, ["ok": true])
  default:
    return reply(id, ["ok": false, "reason": "unknown_kind"])
  }
  let dragButton: CGMouseButton = kind == "move" ? (buttonDown[2] == true ? .right : buttonDown[1] == true ? .center : .left) : cgButton
  guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: dragButton) else { return reply(id, ["ok": false, "reason": "event"]) }
  if kind == "down" || kind == "up" { e.setIntegerValueField(.mouseEventClickState, value: 1) }
  e.post(tap: .cghidEventTap)
  reply(id, ["ok": true])
}

var signalSources: [DispatchSourceSignal] = []
func handle(_ line: String) {
  guard let data = line.data(using: .utf8), let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
  let id = msg["id"]
  switch msg["cmd"] as? String ?? "" {
  case "trust":
    let prompt = msg["prompt"] as? Bool ?? false
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    reply(id, ["ok": true, "trusted": AXIsProcessTrustedWithOptions(options), "screen": CGPreflightScreenCaptureAccess()])
  case "windows":
    let out = windows().filter { $0.layer == 0 && $0.bounds.width > 80 && $0.bounds.height > 60 && $0.app != "WindowManager" }.map { w -> [String: Any] in
      ["id": w.id, "pid": Int(w.pid), "app": w.app, "title": w.title,
       "x": Double(w.bounds.minX), "y": Double(w.bounds.minY), "width": Double(w.bounds.width), "height": Double(w.bounds.height)]
    }
    reply(id, ["ok": true, "windows": out])
  case "activate":
    if let pid = msg["pid"] as? Int { activate(Int32(pid)) }
    reply(id, ["ok": true])
  case "release":
    // Kill switch: let go of any button a viewer was holding.
    let loc = CGEvent(source: nil)?.location ?? .zero
    for (b, down) in buttonDown where down {
      let t: CGEventType = b == 2 ? .rightMouseUp : b == 1 ? .otherMouseUp : .leftMouseUp
      CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: loc, mouseButton: b == 2 ? .right : b == 1 ? .center : .left)?.post(tap: .cghidEventTap)
      buttonDown[b] = false
    }
    reply(id, ["ok": true])
  case "input":
    handleInput(id, msg["windowId"] as? Int ?? -1, msg["ev"] as? [String: Any] ?? [:])
  default:
    reply(id, ["ok": false, "reason": "unknown_cmd"])
  }
}

// Restore staged windows when the desktop app quits or the pipe closes.
for sig in [SIGTERM, SIGINT, SIGHUP] {
  signal(sig, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  source.setEventHandler { restoreAllAndExit() }
  source.resume()
  signalSources.append(source)
}
Thread.detachNewThread {
  while let line = readLine() { DispatchQueue.main.async { handle(line) } }
  DispatchQueue.main.async { restoreAllAndExit() }
}
NSApplication.shared.setActivationPolicy(.prohibited)
RunLoop.main.run()
`;

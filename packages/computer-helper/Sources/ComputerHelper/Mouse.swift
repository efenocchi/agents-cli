import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

// Mouse-based interactions: drag and right-click. Prefers native AX actions
// when the element supports them; falls back to synthesized CGEvents posted
// to the target pid.
enum Mouse {

    // MARK: - drag

    static func drag(params: [String: Any], cache: ElementCache) throws -> [String: Any] {
        try AX.ensureTrusted()
        let pid = try Params.int(params, "pid")

        // Hard floor + user allow list. Throws permission_denied / target_excluded
        // before any CGEvent is synthesized.
        try ensurePidAllowed(pid)

        let button = Params.stringOpt(params, "button") ?? "left"
        guard button == "left" || button == "right" else {
            throw RPCError.invalid("button must be 'left' or 'right'")
        }

        let fromPt = try resolveSource(params: params, pid: pid, cache: cache)
        let toPt = try resolveDest(params: params, pid: pid, cache: cache)

        // Try native AX move if both endpoints came from elements and the
        // source supports AXMove. Rarely honored but cheapest when it is.
        if let srcId = Params.stringOpt(params, "element_id"),
           let srcEl = cache.get(pid: pid, id: srcId) {
            let actions = copyActionNames(srcEl)
            if actions.contains("AXMove") {
                let err = AXUIElementPerformAction(srcEl, "AXMove" as CFString)
                if err == .success {
                    return ["ok": true, "method": "AXMove"]
                }
            }
        }

        // Fallback: synthesize the full move->down->drag->up sequence through
        // the centralized synthesizer (HID tap, fully-stamped events) so it
        // lands on Chromium/UXP/canvas surfaces, not just plain AppKit views.
        let background = Params.bool(params, "background")
        CursorSprite.shared.showFor(drag: fromPt)
        let method = try EventSynth.drag(from: fromPt, to: toPt, pid: pid, button: button, background: background)
        // Brief lingering flash at destination, then hide.
        CursorSprite.shared.flash(at: toPt)

        return ["ok": true, "method": method]
    }

    // MARK: - right click

    static func rightClick(params: [String: Any], cache: ElementCache) throws -> [String: Any] {
        try AX.ensureTrusted()
        let pid = try Params.int(params, "pid")

        // Gate BEFORE the coords-fallback branch to close the bypass path.
        try ensurePidAllowed(pid)

        // Coords fallback for canvas/games/inaccessible elements.
        if Params.stringOpt(params, "element_id") == nil {
            if let x = Params.intOpt(params, "x"), let y = Params.intOpt(params, "y") {
                let pt = CGPoint(x: x, y: y)
                CursorSprite.shared.flash(at: pt)
                let method = try EventSynth.click(at: pt, pid: pid, button: "right", clickCount: 1, background: Params.bool(params, "background"))
                return ["ok": true, "method": method, "at": [x, y]]
            }
            throw RPCError.invalid("pass either element_id or x,y")
        }

        let elementId = try Params.string(params, "element_id")

        guard let el = cache.get(pid: pid, id: elementId) else {
            throw RPCError.stale()
        }

        // AXShowMenu is the AX-native contextual menu trigger. When supported,
        // it's focus-free. Fall back to a synthesized right-click at element center.
        let actions = copyActionNames(el)
        if actions.contains("AXShowMenu") {
            if let center = elementCenter(el) {
                CursorSprite.shared.flash(at: center)
            }
            let err = AXUIElementPerformAction(el, "AXShowMenu" as CFString)
            if err == .success {
                return ["ok": true, "method": "AXShowMenu"]
            }
        }

        guard let center = elementCenter(el) else {
            throw RPCError(code: "action_failed", message: "element has no frame")
        }
        CursorSprite.shared.flash(at: center)
        let method = try EventSynth.click(at: center, pid: pid, button: "right", clickCount: 1, background: Params.bool(params, "background"))
        return ["ok": true, "method": method]
    }

    // MARK: - focus window

    // After NSRunningApplication.activate returns true the window-raise is
    // still propagating through WindowServer. Callers that immediately
    // screenshot or describe will race the raise and read the previous
    // foreground app. Poll frontmostApplication for up to 200 ms so the
    // helper only reports ok once the app is actually frontmost.
    private static let focusPollTotalMs: Int = 200
    private static let focusPollIntervalMs: Int = 20

    static func focusWindow(params: [String: Any]) throws -> [String: Any] {
        let pid = try Params.int(params, "pid")

        try ensurePidAllowed(pid)

        guard let app = NSRunningApplication(processIdentifier: pid_t(pid)) else {
            throw RPCError.appMissing(pid)
        }

        let wasHidden = app.isHidden
        if wasHidden { app.unhide() }

        let ok = app.activate(options: [.activateIgnoringOtherApps])
        if !ok {
            throw RPCError(code: "action_failed", message: "activate returned false")
        }

        let ticks = focusPollTotalMs / focusPollIntervalMs
        var elapsedMs = 0
        for _ in 0..<ticks {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(pid) {
                return ["ok": true, "was_minimized": wasHidden, "focus_elapsed_ms": elapsedMs]
            }
            Thread.sleep(forTimeInterval: Double(focusPollIntervalMs) / 1000.0)
            elapsedMs += focusPollIntervalMs
        }
        throw RPCError(code: "focus_timeout", message: "app pid=\(pid) did not become frontmost within \(focusPollTotalMs)ms (modal-blocked or invisible?)")
    }

    // MARK: - helpers

    private static func resolveSource(params: [String: Any], pid: Int, cache: ElementCache) throws -> CGPoint {
        if let eid = Params.stringOpt(params, "element_id") {
            guard let el = cache.get(pid: pid, id: eid) else { throw RPCError.stale() }
            guard let c = elementCenter(el) else { throw RPCError(code: "action_failed", message: "source element has no frame") }
            return c
        }
        if let from = params["from"] as? [Any], from.count == 2,
           let x = numeric(from[0]), let y = numeric(from[1]) {
            return CGPoint(x: x, y: y)
        }
        throw RPCError.invalid("pass either element_id or from=[x, y]")
    }

    private static func resolveDest(params: [String: Any], pid: Int, cache: ElementCache) throws -> CGPoint {
        if let eid = Params.stringOpt(params, "to_element_id") {
            guard let el = cache.get(pid: pid, id: eid) else { throw RPCError.stale() }
            guard let c = elementCenter(el) else { throw RPCError(code: "action_failed", message: "destination element has no frame") }
            return c
        }
        if let to = params["to"] as? [Any], to.count == 2,
           let x = numeric(to[0]), let y = numeric(to[1]) {
            return CGPoint(x: x, y: y)
        }
        throw RPCError.invalid("pass either to_element_id or to=[x, y]")
    }

    static func elementCenter(_ el: AXUIElement) -> CGPoint? {
        var posRaw: CFTypeRef?
        var sizeRaw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRaw) == .success,
              AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRaw) == .success,
              let posVal = posRaw, let sizeVal = sizeRaw,
              CFGetTypeID(posVal) == AXValueGetTypeID(),
              CFGetTypeID(sizeVal) == AXValueGetTypeID() else {
            return nil
        }
        var pos = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(posVal as! AXValue, .cgPoint, &pos)
        AXValueGetValue(sizeVal as! AXValue, .cgSize, &size)
        return CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2)
    }

    private static func copyActionNames(_ el: AXUIElement) -> [String] {
        var arr: CFArray?
        guard AXUIElementCopyActionNames(el, &arr) == .success, let arr = arr else { return [] }
        return (arr as NSArray).compactMap { $0 as? String }
    }

    private static func numeric(_ v: Any) -> CGFloat? {
        if let d = v as? Double { return CGFloat(d) }
        if let i = v as? Int { return CGFloat(i) }
        if let s = v as? String, let d = Double(s) { return CGFloat(d) }
        return nil
    }
}

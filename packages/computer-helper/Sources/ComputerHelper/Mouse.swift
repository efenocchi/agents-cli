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

        // Fallback: synthesize mouse down at source, a series of dragged events,
        // and an up at the destination. Posted to pid so the user's focus is
        // minimally disrupted.
        let downType: CGEventType = button == "right" ? .rightMouseDown : .leftMouseDown
        let dragType: CGEventType = button == "right" ? .rightMouseDragged : .leftMouseDragged
        let upType: CGEventType = button == "right" ? .rightMouseUp : .leftMouseUp
        let mouseButton: CGMouseButton = button == "right" ? .right : .left

        guard let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: fromPt, mouseButton: mouseButton) else {
            throw RPCError(code: "action_failed", message: "could not create mouseDown event")
        }
        CursorSprite.shared.showFor(drag: fromPt)
        down.postToPid(pid_t(pid))

        // Many drag-and-drop implementations (NSView, drop targets, sortable
        // lists) need a minimum hold after mouseDown before recognising the
        // gesture as a drag rather than a click. Without this dwell the
        // sequence is sometimes interpreted as a single click.
        Thread.sleep(forTimeInterval: 0.05)

        // Intermediate drag events help apps that watch the event stream.
        let steps = 10
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let x = fromPt.x + (toPt.x - fromPt.x) * CGFloat(t)
            let y = fromPt.y + (toPt.y - fromPt.y) * CGFloat(t)
            let pt = CGPoint(x: x, y: y)
            CursorSprite.shared.move(to: pt)
            if let drag = CGEvent(mouseEventSource: nil, mouseType: dragType, mouseCursorPosition: pt, mouseButton: mouseButton) {
                drag.postToPid(pid_t(pid))
            }
            Thread.sleep(forTimeInterval: 0.01)
        }

        guard let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: toPt, mouseButton: mouseButton) else {
            throw RPCError(code: "action_failed", message: "could not create mouseUp event")
        }
        up.postToPid(pid_t(pid))
        // Brief lingering flash at destination, then hide.
        CursorSprite.shared.flash(at: toPt)

        return ["ok": true, "method": "CGEvent"]
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
                guard let down = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: pt, mouseButton: .right),
                      let up = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: pt, mouseButton: .right) else {
                    throw RPCError(code: "action_failed", message: "could not create right click event")
                }
                down.postToPid(pid_t(pid))
                up.postToPid(pid_t(pid))
                return ["ok": true, "method": "CGEvent", "at": [x, y]]
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

        guard let down = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: center, mouseButton: .right),
              let up = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: center, mouseButton: .right) else {
            throw RPCError(code: "action_failed", message: "could not create right click event")
        }
        down.postToPid(pid_t(pid))
        up.postToPid(pid_t(pid))
        return ["ok": true, "method": "CGEvent"]
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

import Foundation

struct RPCError: Error {
    let code: String
    let message: String

    static func notFound(_ what: String) -> RPCError {
        RPCError(code: "element_not_found", message: what)
    }
    static func stale() -> RPCError {
        RPCError(code: "element_stale", message: "element handle expired, re-describe")
    }
    static func unsupported(_ action: String) -> RPCError {
        RPCError(code: "action_unsupported", message: action)
    }
    static func denied(_ reason: String) -> RPCError {
        RPCError(code: "permission_denied", message: reason)
    }
    static func excluded(_ bundleId: String) -> RPCError {
        RPCError(code: "target_excluded", message: bundleId)
    }
    static func appMissing(_ pid: Int) -> RPCError {
        RPCError(code: "app_not_found", message: "pid \(pid)")
    }
    static func invalid(_ msg: String) -> RPCError {
        RPCError(code: "invalid_params", message: msg)
    }
}

// Bundle IDs the helper refuses to operate on. Prevents agent self-pwn and
// avoids automating sensitive system UIs.
let DENY_BUNDLE_IDS: Set<String> = [
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "ai.getrush.app",
    "com.apple.systempreferences",
    "com.apple.keychainaccess",
    "com.apple.tccd",
    "com.apple.SecurityAgent",
]

final class Dispatcher {
    let cache: ElementCache

    init(cache: ElementCache) {
        self.cache = cache
    }

    func dispatch(method: String, params: [String: Any]) throws -> [String: Any] {
        switch method {
        case "ping":
            return ["pong": true]
        case "trust_status":
            // Diagnostic: report AX trust + identity without throwing. Useful
            // when TCC grants look right in the UI but AX calls still 403.
            let pid = Int(ProcessInfo.processInfo.processIdentifier)
            let path = Bundle.main.executablePath ?? CommandLine.arguments.first ?? ""
            return [
                "trusted": AX.isTrusted(),
                "pid": pid,
                "path": path,
            ]
        case "list_apps":
            return try Apps.listApps()
        case "describe":
            return try AX.describe(params: params, cache: cache)
        case "click":
            return try AX.click(params: params, cache: cache)
        case "type":
            return try AX.setValue(params: params, cache: cache)
        case "key":
            return try Events.sendKey(params: params)
        case "scroll":
            return try AX.scroll(params: params, cache: cache)
        case "screenshot":
            return try Screenshot.capture(params: params)
        case "wait":
            return try Wait.run(params: params, cache: cache)
        case "drag":
            return try Mouse.drag(params: params, cache: cache)
        case "focus_window":
            return try Mouse.focusWindow(params: params)
        case "right_click":
            return try Mouse.rightClick(params: params, cache: cache)
        case "get_text":
            return try AX.getText(params: params, cache: cache)
        case "notify":
            return try Notify.post(params: params)
        case "launch_app":
            return try Apps.launchApp(params: params)
        default:
            throw RPCError(code: "method_not_found", message: method)
        }
    }
}

// Small helpers for poking at untyped RPC param dicts.
enum Params {
    static func int(_ p: [String: Any], _ key: String) throws -> Int {
        if let v = p[key] as? Int { return v }
        if let v = p[key] as? Double { return Int(v) }
        if let v = p[key] as? String, let i = Int(v) { return i }
        throw RPCError.invalid("missing int param: \(key)")
    }
    static func intOpt(_ p: [String: Any], _ key: String) -> Int? {
        if let v = p[key] as? Int { return v }
        if let v = p[key] as? Double { return Int(v) }
        return nil
    }
    static func string(_ p: [String: Any], _ key: String) throws -> String {
        if let v = p[key] as? String { return v }
        throw RPCError.invalid("missing string param: \(key)")
    }
    static func stringOpt(_ p: [String: Any], _ key: String) -> String? {
        return p[key] as? String
    }
    static func bool(_ p: [String: Any], _ key: String, default def: Bool = false) -> Bool {
        if let v = p[key] as? Bool { return v }
        return def
    }
}

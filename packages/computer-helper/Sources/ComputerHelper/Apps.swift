import AppKit
import Foundation

enum Apps {
    static func listApps() throws -> [String: Any] {
        let running = NSWorkspace.shared.runningApplications
        var out: [[String: Any]] = []
        for app in running {
            // Filter to GUI apps the agent can meaningfully drive. Background-only
            // processes (activationPolicy == .prohibited) have no UI to describe.
            guard app.activationPolicy == .regular else { continue }
            let pid = Int(app.processIdentifier)
            let bundleId = app.bundleIdentifier ?? ""
            let excluded = DENY_BUNDLE_IDS.contains(bundleId)
            out.append([
                "pid": pid,
                "name": app.localizedName ?? "",
                "bundle_id": bundleId,
                "active": app.isActive,
                "hidden": app.isHidden,
                "excluded": excluded,
            ])
        }
        return ["apps": out]
    }

    // Launch an app by bundle_id, path (to .app bundle or executable), or
    // human name ("Notepad", "Safari"). Returns {pid, name, bundle_id}.
    static func launchApp(params: [String: Any]) throws -> [String: Any] {
        let bundleId = Params.stringOpt(params, "bundle_id")
        let path = Params.stringOpt(params, "path")
        let name = Params.stringOpt(params, "name")

        if bundleId == nil && path == nil && name == nil {
            throw RPCError.invalid("pass one of: bundle_id, path, name")
        }

        var url: URL?
        if let bid = bundleId {
            url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid)
            if url == nil {
                throw RPCError.invalid("bundle_id not found: \(bid)")
            }
        } else if let p = path {
            url = URL(fileURLWithPath: p)
        } else if let n = name {
            // Resolve human name by scanning /Applications first, falling back
            // to `NSWorkspace.urlForApplication(withName:)` which handles the
            // common case where the app exists somewhere registered with
            // LaunchServices.
            let candidatePaths = [
                "/Applications/\(n).app",
                "/System/Applications/\(n).app",
                "/Applications/Utilities/\(n).app",
                "/System/Applications/Utilities/\(n).app",
            ]
            for cp in candidatePaths {
                if FileManager.default.fileExists(atPath: cp) {
                    url = URL(fileURLWithPath: cp)
                    break
                }
            }
            if url == nil {
                if let resolved = NSWorkspace.shared.fullPath(forApplication: n) {
                    url = URL(fileURLWithPath: resolved)
                }
            }
            if url == nil {
                throw RPCError.invalid("app not found by name: \(n)")
            }
        }

        guard let appURL = url else {
            throw RPCError.invalid("could not resolve app")
        }

        // Synchronously launch and wait for the pid. NSWorkspace.openApplication
        // is async; use a semaphore so we return the pid to the caller.
        let semaphore = DispatchSemaphore(value: 0)
        var launchedApp: NSRunningApplication?
        var launchErr: Error?

        let config = NSWorkspace.OpenConfiguration()
        config.activates = false // don't steal focus
        NSWorkspace.shared.openApplication(at: appURL, configuration: config) { app, err in
            launchedApp = app
            launchErr = err
            semaphore.signal()
        }

        // 10s timeout — large apps (Xcode) can take a while to cold-start.
        let timedOut = semaphore.wait(timeout: .now() + 10) == .timedOut
        if timedOut {
            throw RPCError(code: "action_failed", message: "launch timed out after 10s for \(appURL.path)")
        }
        if let err = launchErr {
            throw RPCError(code: "action_failed", message: "launch failed: \(err.localizedDescription)")
        }
        guard let app = launchedApp else {
            throw RPCError(code: "action_failed", message: "launch returned no NSRunningApplication")
        }

        return [
            "pid": Int(app.processIdentifier),
            "name": app.localizedName ?? "",
            "bundle_id": app.bundleIdentifier ?? "",
        ]
    }
}

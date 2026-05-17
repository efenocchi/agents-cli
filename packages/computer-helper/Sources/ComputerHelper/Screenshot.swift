import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import UniformTypeIdentifiers

// Per-window screenshot via ScreenCaptureKit. CGWindowListCreateImage was
// obsoleted in macOS 15 (Sequoia) and removed from the public SDK; the legacy
// shim still answers at runtime today but Apple has stopped guaranteeing it.
// SCK is the supported replacement, captures across Spaces, and accepts an
// SCWindow target by windowID without raising the window (focus-safe).
//
// Window picking: an app's first CGWindowList entry is non-deterministic and
// for canvas/video apps (CapCut, OBS, broadcast tools) is often a tiny
// transparent overlay rather than the editor surface. We pick the largest
// onscreen layer-0 alpha>0 window owned by the pid instead.
enum Screenshot {
    static func capture(params: [String: Any]) throws -> [String: Any] {
        let pid = try Params.int(params, "pid")
        let quality = max(1, min(100, Params.intOpt(params, "quality") ?? 85))

        // SCK is async; bridge to the sync RPC dispatcher with a semaphore.
        // 5s is well above the 100-300ms typical SCK frame grab; if we hit
        // it something is wrong (permission, hung daemon, denied window).
        let semaphore = DispatchSemaphore(value: 0)
        var captured: Result<[String: Any], Error>!

        Task {
            do {
                captured = .success(try await captureAsync(pid: pid, quality: quality))
            } catch {
                captured = .failure(error)
            }
            semaphore.signal()
        }

        let timedOut = semaphore.wait(timeout: .now() + 5.0) == .timedOut
        if timedOut {
            throw RPCError(code: "action_failed", message: "ScreenCaptureKit timed out after 5s (denied Screen Recording permission?)")
        }
        return try captured.get()
    }

    private static func captureAsync(pid: Int, quality: Int) async throws -> [String: Any] {
        // SCShareableContent.current enumerates everything the helper is
        // allowed to capture. Filters by pid and picks the dominant editor
        // window (largest area, layer 0, on-screen). Returns app_not_found
        // when no candidate exists — same contract as the old CGWindowList
        // implementation.
        let content: SCShareableContent
        do {
            // onScreenWindowsOnly=false matches CapCut and other apps whose
            // editor window is on a different Space (or otherwise filtered
            // out by the on-screen check). We then prefer the largest
            // layer-0 window, which is empirically the editor.
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            throw RPCError(code: "action_failed", message: "SCShareableContent failed: \(error.localizedDescription) (grant Screen Recording to ComputerHelper)")
        }

        let candidates = content.windows.filter {
            $0.owningApplication?.processID == pid_t(pid) && $0.windowLayer == 0
        }
        guard !candidates.isEmpty else {
            // Fall back to any-layer windows if no layer-0 candidate exists.
            // Some apps put real UI on non-zero layers (rare but seen on
            // older Qt builds). Better to capture something than fail blind.
            let anyLayer = content.windows.filter { $0.owningApplication?.processID == pid_t(pid) }
            guard let largest = anyLayer.max(by: { area($0.frame) < area($1.frame) }) else {
                throw RPCError(code: "action_failed", message: "no visible windows for pid \(pid)")
            }
            return try await snap(window: largest, quality: quality)
        }
        let largest = candidates.max(by: { area($0.frame) < area($1.frame) })!
        return try await snap(window: largest, quality: quality)
    }

    private static func area(_ r: CGRect) -> CGFloat { r.width * r.height }

    private static func snap(window: SCWindow, quality: Int) async throws -> [String: Any] {
        let filter = SCContentFilter(desktopIndependentWindow: window)

        let config = SCStreamConfiguration()
        // sourceRect=CGRect.null tells SCK to use the window's natural bounds.
        // pixelFormat=BGRA is the only format we can reliably ferry through
        // CGImage->NSBitmapImageRep->JPEG without an extra Metal hop.
        config.width = max(Int(window.frame.width), 1)
        config.height = max(Int(window.frame.height), 1)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        config.capturesAudio = false

        let cgImage: CGImage
        do {
            cgImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        } catch {
            throw RPCError(code: "action_failed", message: "SCK captureImage failed: \(error.localizedDescription)")
        }

        let rep = NSBitmapImageRep(cgImage: cgImage)
        guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: Double(quality) / 100.0]) else {
            throw RPCError(code: "action_failed", message: "JPEG encode failed")
        }
        return [
            "image_data": data.base64EncodedString(),
            "mime_type": "image/jpeg",
            "width": cgImage.width,
            "height": cgImage.height,
        ]
    }
}

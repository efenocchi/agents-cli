import AppKit
import Foundation

// Line-delimited JSON-RPC over stdio.
// Each line in: {"id":N,"method":"...","params":{...}}
// Each line out: {"id":N,"result":{...}} or {"id":N,"error":{"code":"...","message":"..."}}

// Initialize the WindowServer/SkyLight connection. ScreenCaptureKit asserts
// CGS_REQUIRE_INIT inside SCScreenshotManager when invoked from a process
// that hasn't touched AppKit yet. Bare `swift` CLI processes and our helper
// (LSUIElement, no run loop) both hit this. Touching NSApplication.shared
// is enough to bootstrap the connection without starting a run loop.
//
// We also need the run loop running on the main thread so CursorSprite can
// display its overlay NSWindow when the agent clicks. The RPC stdin loop
// therefore moves to a background queue; NSApp.run() owns main.
_ = NSApplication.shared
NSApplication.shared.setActivationPolicy(.accessory)

let stdin = FileHandle.standardInput
let stdout = FileHandle.standardOutput
let stderr = FileHandle.standardError

let cache = ElementCache()
let dispatcher = Dispatcher(cache: cache)
let writeLock = NSLock()

func writeLine(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else {
        return
    }
    writeLock.lock()
    stdout.write(data)
    stdout.write("\n".data(using: .utf8)!)
    writeLock.unlock()
}

func log(_ msg: String) {
    stderr.write("[computer-helper] \(msg)\n".data(using: .utf8)!)
}

log("started pid=\(getpid())")

// RPC loop on a background queue. On EOF (parent closed stdin) we
// asynchronously terminate NSApp so the main run loop unblocks too.
// Without this the helper would hang after the parent exits because the
// main thread is still pumping the NSApp run loop.
DispatchQueue.global(qos: .userInteractive).async {
    var buffer = Data()
    while true {
        let chunk = stdin.availableData
        if chunk.isEmpty {
            log("exit (stdin EOF)")
            DispatchQueue.main.async { NSApp.terminate(nil) }
            return
        }
        buffer.append(chunk)

        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: 0..<nl)
            buffer.removeSubrange(0...nl)

            guard !line.isEmpty else { continue }

            do {
                guard let obj = try JSONSerialization.jsonObject(with: line) as? [String: Any],
                      let id = obj["id"],
                      let method = obj["method"] as? String
                else {
                    writeLine(["id": NSNull(), "error": ["code": "bad_request", "message": "malformed JSON-RPC"]])
                    continue
                }
                let params = obj["params"] as? [String: Any] ?? [:]

                let response: [String: Any]
                do {
                    let result = try dispatcher.dispatch(method: method, params: params)
                    response = ["id": id, "result": result]
                } catch let err as RPCError {
                    response = ["id": id, "error": ["code": err.code, "message": err.message]]
                } catch {
                    response = ["id": id, "error": ["code": "internal", "message": "\(error)"]]
                }
                writeLine(response)
            } catch {
                writeLine(["id": NSNull(), "error": ["code": "bad_request", "message": "\(error)"]])
            }
        }
    }
}

// Hand main thread to AppKit's run loop. Blocks until NSApp.terminate
// fires from the RPC loop on stdin EOF.
NSApplication.shared.run()

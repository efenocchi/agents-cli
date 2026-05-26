import Foundation
import Security

func writeStderr(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

func die(_ code: Int32, _ message: String) -> Never {
    writeStderr(message)
    exit(code)
}

func findItem(service: String, account: String, synchronizable: CFTypeRef) -> String? {
    let query: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
        kSecAttrSynchronizable: synchronizable,
        kSecReturnData: kCFBooleanTrue!,
        kSecMatchLimit: kSecMatchLimitOne,
    ]
    var result: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let data = result as? Data,
          let value = String(data: data, encoding: .utf8) else { return nil }
    return value
}

// Build a SecAccess that lists this binary as a trusted reader. Items
// written with this access bypass the macOS "enter password" sheet on the
// device where they were created. The ACL does NOT replicate via iCloud
// Keychain — items synced FROM another Mac arrive with a default ACL, so
// the first read on a fresh device still incurs one password prompt.
// Deprecated since 10.10 but still the only path that supports trusted-app
// ACLs (kSecAttrAccessControl is biometry-only and incompatible with sync).
func buildSelfTrustedAccess() -> SecAccess? {
    var selfApp: SecTrustedApplication?
    guard SecTrustedApplicationCreateFromPath(nil, &selfApp) == errSecSuccess,
          let app = selfApp else { return nil }
    var access: SecAccess?
    let label = "agents-cli secrets" as CFString
    guard SecAccessCreate(label, [app] as CFArray, &access) == errSecSuccess else {
        return nil
    }
    return access
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    die(2, "Usage: agents-keychain <get|set|delete|has|list> ...")
}

let cmd = args[1]

switch cmd {

case "list":
    // list <prefix> — enumerate generic-password items whose service starts with <prefix>.
    guard args.count == 3 else { die(2, "Usage: agents-keychain list <prefix>") }
    let prefix = args[2]
    guard !prefix.isEmpty else { die(2, "list requires non-empty prefix") }
    let user = ProcessInfo.processInfo.environment["USER"] ?? NSUserName()
    let query: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecMatchLimit: kSecMatchLimitAll,
        kSecReturnAttributes: kCFBooleanTrue!,
        kSecAttrSynchronizable: kSecAttrSynchronizableAny,
    ]
    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { exit(0) }
    if status != errSecSuccess { die(2, "Failed to enumerate keychain (OSStatus \(status))") }
    guard let items = result as? [[String: Any]] else { exit(0) }
    var seen = Set<String>()
    for item in items {
        guard let svce = item[kSecAttrService as String] as? String, svce.hasPrefix(prefix) else { continue }
        guard let acct = item[kSecAttrAccount as String] as? String, acct == user else { continue }
        if seen.insert(svce).inserted {
            print(svce)
        }
    }

case "get":
    // Unauthenticated single-item read. Used by profiles.ts (OAuth token
    // refresh) where a Touch ID prompt on every API call would be brutal.
    // macOS may still show a password prompt if the item's ACL doesn't
    // trust this binary — but reads of items we wrote via `set` (which
    // attaches kSecAttrAccess) are silent.
    guard args.count == 4 else { die(2, "Usage: agents-keychain get <service> <account>") }
    let (service, account) = (args[2], args[3])
    guard let value = findItem(service: service, account: account, synchronizable: kSecAttrSynchronizableAny) else { exit(1) }
    print(value, terminator: "")

case "has":
    guard args.count == 4 else { die(2, "Usage: agents-keychain has <service> <account>") }
    let (service, account) = (args[2], args[3])
    exit(findItem(service: service, account: account, synchronizable: kSecAttrSynchronizableAny) != nil ? 0 : 1)

case "set":
    guard args.count == 4 || args.count == 5 else { die(2, "Usage: agents-keychain set <service> <account> [nosync]") }
    let (service, account) = (args[2], args[3])
    // Device-local items used to go through `security` and retain their ACL.
    // Default to iCloud-synced (kSecAttrSynchronizable=true). Pass `nosync` as the 4th arg
    // for device-local writes — used by bundles without --icloud-sync.
    let syncFlag: CFBoolean = (args.count == 5 && args[4] == "nosync") ? kCFBooleanFalse! : kCFBooleanTrue!
    let stdinData = FileHandle.standardInput.readDataToEndOfFile()
    guard !stdinData.isEmpty, var password = String(data: stdinData, encoding: .utf8) else {
        die(2, "Failed to read password from stdin")
    }
    while password.hasSuffix("\n") || password.hasSuffix("\r") { password = String(password.dropLast()) }
    guard let valueData = password.data(using: .utf8) else { die(2, "Failed to encode password") }

    let access = buildSelfTrustedAccess()

    let matchAttrs: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
        kSecAttrSynchronizable: syncFlag,
    ]
    // SecItemUpdate preserves the existing ACL — we can't change it here.
    // For items that pre-date this version, rotate (delete + re-add) to
    // pick up the trusted-app ACL.
    var status = SecItemUpdate(matchAttrs as CFDictionary, [kSecValueData: valueData] as CFDictionary)
    if status == errSecItemNotFound {
        var addAttrs: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service as CFString,
            kSecAttrAccount: account as CFString,
            kSecAttrSynchronizable: syncFlag,
            kSecValueData: valueData,
        ]
        // kSecAttrAccess (legacy trusted-app ACL) is incompatible with
        // kSecAttrSynchronizable=true — SecItemAdd returns errSecParam (-50)
        // when both are set. iCloud-synced items use device-level keychain
        // unlock instead of a per-item ACL. Only attach the ACL to non-sync
        // (device-local) items, where it stops the legacy "enter password"
        // sheet on each helper read.
        if let acc = access, syncFlag == kCFBooleanFalse! { addAttrs[kSecAttrAccess] = acc }
        status = SecItemAdd(addAttrs as CFDictionary, nil)
    }
    if status == errSecNotAvailable {
        die(2, "iCloud Keychain is not enabled. Turn it on in System Settings > [Apple ID] > iCloud > Passwords & Keychain.")
    }
    guard status == errSecSuccess else { die(2, "Failed to write keychain item (OSStatus \(status))") }

    // When writing as synchronizable, remove any non-sync duplicate left from a previous write.
    // When writing as nosync, leave the synchronizable copy alone (caller manages explicit sync state).
    if syncFlag == kCFBooleanTrue! {
        SecItemDelete([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service as CFString,
            kSecAttrAccount: account as CFString,
            kSecAttrSynchronizable: kCFBooleanFalse!,
        ] as CFDictionary)
    }

case "delete":
    guard args.count == 4 else { die(2, "Usage: agents-keychain delete <service> <account>") }
    let (service, account) = (args[2], args[3])
    var found = false
    for sync in [kCFBooleanTrue!, kCFBooleanFalse!] as [CFBoolean] {
        if SecItemDelete([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service as CFString,
            kSecAttrAccount: account as CFString,
            kSecAttrSynchronizable: sync,
        ] as CFDictionary) == errSecSuccess { found = true }
    }
    exit(found ? 0 : 1)

default:
    die(2, "Unknown command: \(cmd)")
}

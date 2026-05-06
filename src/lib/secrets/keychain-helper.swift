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

let args = CommandLine.arguments
guard args.count == 4 else { die(2, "Usage: agents-keychain <get|set|delete|has> <service> <account>") }

let (cmd, service, account) = (args[1], args[2], args[3])

switch cmd {

case "get":
    guard let value = findItem(service: service, account: account, synchronizable: kSecAttrSynchronizableAny) else { exit(1) }
    print(value, terminator: "")

case "has":
    exit(findItem(service: service, account: account, synchronizable: kSecAttrSynchronizableAny) != nil ? 0 : 1)

case "set":
    let stdinData = FileHandle.standardInput.readDataToEndOfFile()
    guard !stdinData.isEmpty, var password = String(data: stdinData, encoding: .utf8) else {
        die(2, "Failed to read password from stdin")
    }
    while password.hasSuffix("\n") || password.hasSuffix("\r") { password = String(password.dropLast()) }
    guard let valueData = password.data(using: .utf8) else { die(2, "Failed to encode password") }

    let baseAttrs: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
        kSecAttrSynchronizable: kCFBooleanTrue!,
    ]
    var status = SecItemUpdate(baseAttrs as CFDictionary, [kSecValueData: valueData] as CFDictionary)
    if status == errSecItemNotFound {
        let addAttrs: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service as CFString,
            kSecAttrAccount: account as CFString,
            kSecAttrSynchronizable: kCFBooleanTrue!,
            kSecValueData: valueData,
        ]
        status = SecItemAdd(addAttrs as CFDictionary, nil)
    }
    if status == errSecNotAvailable {
        die(2, "iCloud Keychain is not enabled. Turn it on in System Settings > [Apple ID] > iCloud > Passwords & Keychain.")
    }
    guard status == errSecSuccess else { die(2, "Failed to write keychain item (OSStatus \(status))") }

    // Remove non-sync duplicate left from before this version
    SecItemDelete([
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service as CFString,
        kSecAttrAccount: account as CFString,
        kSecAttrSynchronizable: kCFBooleanFalse!,
    ] as CFDictionary)

case "delete":
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

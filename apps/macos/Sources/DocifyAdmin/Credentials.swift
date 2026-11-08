import Foundation
import Security

/// LiteLLM connection for the CLI. The URL is not secret and lives in UserDefaults; the key lives in the Keychain.
enum Credentials {
    private static let service = "docify-admin"
    private static let keyAccount = "litellm-api-key"
    private static let urlDefaultsKey = "litellmBaseUrl"
    // Read once: every Keychain read of an unsigned, rebuilt binary can raise an access prompt.
    nonisolated(unsafe) private static var cachedKey: String??

    static var baseUrl: String {
        get { UserDefaults.standard.string(forKey: urlDefaultsKey) ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: urlDefaultsKey) }
    }

    static var apiKey: String {
        if let cached = cachedKey { return cached ?? "" }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: keyAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        let value = status == errSecSuccess ? (item as? Data).map { String(decoding: $0, as: UTF8.self) } : nil
        cachedKey = .some(value)
        return value ?? ""
    }

    /// An empty key removes the Keychain item.
    static func setApiKey(_ value: String) throws {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: keyAccount,
        ]
        let deleted = SecItemDelete(base as CFDictionary)
        guard deleted == errSecSuccess || deleted == errSecItemNotFound else { throw keychainError(deleted) }
        if !value.isEmpty {
            var add = base
            add[kSecValueData as String] = Data(value.utf8)
            let added = SecItemAdd(add as CFDictionary, nil)
            guard added == errSecSuccess else { throw keychainError(added) }
        }
        cachedKey = .some(value.isEmpty ? nil : value)
    }

    private static func keychainError(_ status: OSStatus) -> CLIError {
        CLIError(message: "Keychain error \(status): \(SecCopyErrorMessageString(status, nil) as String? ?? "unknown")")
    }
}

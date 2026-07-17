import Foundation
import Security

struct HostCredentialVault: Sendable {
    private let service = "cn.aelion.aru.host-console.v2"
    private let account = "home"

    private var identity: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func read() throws -> String? {
        var query = identity
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            throw HostCredentialError.readFailed(status)
        }
        return value
    }

    func write(_ credential: String) throws {
        let data = Data(credential.utf8)
        let updateStatus = SecItemUpdate(
            identity as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw HostCredentialError.writeFailed(updateStatus)
        }
        var create = identity
        create[kSecValueData as String] = data
        create[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(create as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw HostCredentialError.writeFailed(addStatus)
        }
    }

    func delete() throws {
        let status = SecItemDelete(identity as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw HostCredentialError.deleteFailed(status)
        }
    }
}

enum HostCredentialError: LocalizedError {
    case readFailed(OSStatus)
    case writeFailed(OSStatus)
    case deleteFailed(OSStatus)

    var errorDescription: String? {
        switch self {
        case .readFailed: L10n.keychainReadFailed
        case .writeFailed: L10n.keychainWriteFailed
        case .deleteFailed: L10n.keychainDeleteFailed
        }
    }
}

import Foundation

struct BackupPackageMetadata: Decodable, Equatable, Sendable {
    let sourceName: String
    let createdAt: Int64
    let packageByteCount: Int64
    let objectCounts: [String: Int]
    let binaryCount: Int
    let envelopeFormat: String?
    let plaintextByteCount: Int64?

    var isIncremental: Bool { envelopeFormat == "aru-native-backup-snapshot" }
    var contentByteCount: Int64 { plaintextByteCount ?? packageByteCount }
}

struct BackupPackage: Decodable, Equatable, Identifiable, Sendable {
    let remotePackageId: String
    let metadata: BackupPackageMetadata
    let uploadedAt: Int64

    var id: String { remotePackageId }
}

struct BackupInventory: Decodable, Equatable, Sendable {
    let packages: [BackupPackage]
}

enum HostBackupRetentionMode: String, Codable, Equatable, Sendable {
    case keepAll = "keep-all"
    case keepLatest = "keep-latest"
}

struct HostBackupSettings: Decodable, Equatable, Sendable {
    let schema: String
    let retentionMode: HostBackupRetentionMode
    let keepLatestCount: Int?
    let revision: Int
    let updatedAt: Int64
    let lastAppliedAt: Int64?
    let lastDeletedCount: Int
}

struct HostBackupSettingsUpdate: Encodable, Sendable {
    let schema = "aru.selfhost.backup-settings.v1"
    let retentionMode: HostBackupRetentionMode
    let keepLatestCount: Int?
    let expectedRevision: Int
}

struct HostBackupDeletion: Decodable, Sendable {
    let remotePackageId: String
    let deleted: Bool
    let deletedAt: Int64
}

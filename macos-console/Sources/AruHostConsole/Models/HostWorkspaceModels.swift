import Foundation

enum HostNodeWorkspaceOwnership: String, Decodable, Equatable, Sendable {
    case hostManaged = "host-managed"
    case userGranted = "user-granted"
}

struct HostNodeWorkspace: Decodable, Equatable, Identifiable, Sendable {
    let schema: String
    let workspaceId: String
    let displayName: String
    let rootDisplayPath: String
    let ownership: HostNodeWorkspaceOwnership
    let isDefault: Bool
    let permissions: [String]
    let createdAt: Int64
    let updatedAt: Int64

    var id: String { workspaceId }
}

struct HostNodeWorkspaceInventory: Decodable, Equatable, Sendable {
    let schema: String
    let workspaces: [HostNodeWorkspace]
}

struct HostNodeWorkspaceGrant: Encodable, Sendable {
    let rootPath: String
    let displayName: String
}

struct HostNodeWorkspaceRevocation: Decodable, Sendable {
    let workspaceId: String
    let deleted: Bool
    let deletedAt: Int64
}

struct HostWorkspaceJob: Decodable, Equatable, Identifiable, Sendable {
    let jobId: String
    let projectId: String
    let runtime: String
    let state: String
    let queuedAt: Int64
    let startedAt: Int64?
    let completedAt: Int64?
    let failureMessage: String?
    let maximumRuntimeSeconds: Int64?

    var id: String { jobId }
}

struct HostWorkspaceJobInventory: Decodable, Equatable, Sendable {
    let schema: String
    let jobs: [HostWorkspaceJob]
}

struct HostWorkspaceJobPolicy: Codable, Equatable, Sendable {
    let schema: String
    let defaultMaximumRuntimeSeconds: Int64?
    let updatedAt: Int64
}

struct HostWorkspaceJobPolicyUpdate: Encodable, Sendable {
    let schema = "aru.selfhost.workspace-job-policy.v1"
    let defaultMaximumRuntimeSeconds: Int64?
}

struct HostArtifactProducer: Decodable, Equatable, Sendable {
    let kind: String
    let projectId: String?
    let runtime: String?
    let pluginId: String?
}

struct HostArtifact: Decodable, Equatable, Identifiable, Sendable {
    let artifactId: String
    let filename: String
    let mimeType: String
    let byteCount: Int64
    let createdAt: Int64
    let producer: HostArtifactProducer

    var id: String { artifactId }
}

struct HostArtifactInventory: Decodable, Equatable, Sendable {
    let artifacts: [HostArtifact]
}

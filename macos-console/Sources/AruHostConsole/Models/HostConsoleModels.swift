import Foundation

struct HostManifest: Decodable, Equatable, Sendable {
    struct Readiness: Decodable, Equatable, Sendable {
        let status: String
        let reason: String?
    }
    struct Capability: Decodable, Equatable, Sendable {
        let enabled: Bool
        var readiness: Readiness? = nil
        var additionalTransports: Bool? = nil
        let turnExecution: Bool?
        let phase: String?
        let endpoint: String?
        let transport: String?
        let displayName: String?
        let authority: String?
        let network: String?
        let execution: String?
        let packageModes: [String]?
        let runtimes: [String]?
    }

    let schema: String
    let serverId: String
    let nodeKind: String
    let displayName: String
    let serverVersion: String
    let releaseVersion: String?
    let capabilities: [String: Capability]

    var collaboratorHost: Capability? { capabilities["collaborator-host"] }
}

enum HostConsoleSection: String, CaseIterable, Identifiable, Hashable, Sendable {
    case overview
    case backups
    case mcp
    case plugins
    case workspaces
    case runtime
    case artifacts
    case collaborators

    var id: String { rawValue }

    var title: String {
        switch self {
        case .overview: L10n.overview
        case .backups: L10n.backupVault
        case .mcp: L10n.mcpGateway
        case .plugins: L10n.plugins
        case .workspaces: L10n.computerFolders
        case .runtime: L10n.runtime
        case .artifacts: L10n.artifacts
        case .collaborators: L10n.computerCollaborators
        }
    }

    var symbol: String {
        switch self {
        case .overview: "square.grid.2x2"
        case .backups: "archivebox"
        case .mcp: "point.3.connected.trianglepath.dotted"
        case .plugins: "puzzlepiece.extension"
        case .workspaces: "folder.badge.gearshape"
        case .runtime: "terminal"
        case .artifacts: "shippingbox"
        case .collaborators: "person.2"
        }
    }

    /// The Console refreshes only the visible section. Fast-moving job state
    /// receives a shorter cadence; MCP discovery and broader inventories stay
    /// quieter because opening them is already an immediate refresh.
    var automaticRefreshSeconds: Double {
        switch self {
        case .runtime: 3
        case .collaborators: 8
        case .overview, .backups, .mcp, .plugins, .workspaces, .artifacts: 15
        }
    }
}

struct HostDiagnostics: Decodable, Equatable, Sendable {
    struct Capability: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let enabled: Bool
    }

    let schema: String
    let serverId: String
    let serverVersion: String
    let serverTime: Int64
    let manifest: String
    let auth: String
    let capabilities: [Capability]
    let packageCount: Int
    let artifactCount: Int
    let jobCount: Int
    let activeJobCount: Int
    let pluginCount: Int
    let activePluginCount: Int
    let hostedCollaboratorCount: Int
    let nodeWorkspaceCount: Int?
    let readyAgentDriverCount: Int
    let deviceCount: Int
}

struct HostConnectionAddress: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var kind: String
    var baseUrl: String
    var priority: Int = 20

    func validated() throws -> Self {
        guard let url = URL(string: baseUrl.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = url.host, url.user == nil, url.password == nil,
              url.path.isEmpty || url.path == "/", url.query == nil, url.fragment == nil,
              ["http", "https"].contains(url.scheme), ["tailscale", "public-https"].contains(kind) else {
            throw HostAddressCheckError.invalid
        }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        let tailnet = (host.split(separator: ".").count == 4 && parts.count == 4 && parts.allSatisfy { (0...255).contains($0) }
            && parts[0] == 100 && (64...127).contains(parts[1])) || host.hasSuffix(".ts.net")
        guard url.scheme == "https" || (kind == "tailscale" && tailnet) else {
            throw HostAddressCheckError.invalid
        }
        var copy = self
        copy.baseUrl = url.absoluteString.hasSuffix("/") ? String(url.absoluteString.dropLast()) : url.absoluteString
        return copy
    }
}

struct HostNodeSettings: Decodable, Equatable, Sendable {
    let schema: String
    let displayName: String
    let revision: Int
    let updatedAt: Int64
    var additionalTransports: [HostConnectionAddress]? = nil
    var transportProfiles: [HostConnectionAddress]? = nil
}

struct HostNodeSettingsUpdate: Encodable, Sendable {
    let schema = "aru.selfhost.node-settings.v1"
    let displayName: String
    let expectedRevision: Int
    var additionalTransports: [HostConnectionAddress]? = nil
}

struct HostPairedDevice: Decodable, Equatable, Identifiable, Sendable {
    let deviceId: String
    let label: String
    let issuedAt: Int64
    let revokedAt: Int64?
    let isCurrent: Bool

    var id: String { deviceId }
    var isActive: Bool { revokedAt == nil }
}

struct HostPairedDeviceInventory: Decodable, Equatable, Sendable {
    let schema: String
    let currentDeviceId: String
    let devices: [HostPairedDevice]
}

struct HostDeviceRevocation: Decodable, Sendable {
    let schema: String
    let deviceId: String
    let revokedAt: Int64
}

struct HostDeviceRevocationBody: Encodable, Sendable {
    let deviceId: String
}

struct MCPToolAnnotations: Decodable, Equatable, Sendable {
    let readOnlyHint: Bool?
    let destructiveHint: Bool?
    let idempotentHint: Bool?
    let openWorldHint: Bool?
}

struct MCPToolSummary: Decodable, Equatable, Identifiable, Sendable {
    let name: String
    let title: String?
    let description: String?
    let inputSchema: HostJSONValue
    let annotations: MCPToolAnnotations?

    var id: String { name }
}

struct MCPGatewaySnapshot: Equatable, Sendable {
    let serverName: String
    let serverVersion: String
    let protocolVersion: String
    let tools: [MCPToolSummary]
}

struct MCPInitializeEnvelope: Decodable, Sendable {
    struct Result: Decodable, Sendable {
        struct ServerInfo: Decodable, Sendable {
            let name: String
            let version: String
        }

        let protocolVersion: String
        let serverInfo: ServerInfo
    }

    let result: Result
}

struct MCPToolsEnvelope: Decodable, Sendable {
    struct Result: Decodable, Sendable {
        let tools: [MCPToolSummary]
    }

    let result: Result
}

enum HostProviderProtocol: String, Codable, CaseIterable, Equatable, Sendable {
    case openAICompatible = "openai-compatible"
    case anthropicMessages = "anthropic-messages"
}

enum HostProviderAuthMode: String, Codable, CaseIterable, Equatable, Sendable {
    case bearer
    case xAPIKey = "x-api-key"
    case none
}

enum HostProviderHealth: String, Decodable, Equatable, Sendable {
    case unchecked
    case ready
    case unhealthy
}

struct HostProviderSecretStorage: Decodable, Equatable, Sendable {
    let supported: Bool
    let storage: String
    let failure: String?
}

struct HostProviderProfile: Decodable, Equatable, Identifiable, Sendable {
    let schema: String
    let profileId: String
    let displayName: String
    let `protocol`: HostProviderProtocol
    let baseURL: String
    let path: String
    let model: String
    let authMode: HostProviderAuthMode
    let maxOutputTokens: Int?
    let maxToolRounds: Int?
    let revision: Int
    let createdAt: Int64
    let updatedAt: Int64
    let health: HostProviderHealth
    let lastCheckedAt: Int64?
    let lastError: String?
    let hasSecret: Bool

    var id: String { profileId }
}

struct HostProviderProfileInventory: Decodable, Equatable, Sendable {
    let schema: String
    let secretStorage: HostProviderSecretStorage
    let profiles: [HostProviderProfile]
}

struct HostProviderProfileMutation: Encodable, Sendable {
    let expectedRevision: Int?
    let displayName: String
    let `protocol`: HostProviderProtocol
    let baseURL: String
    let path: String
    let model: String
    let authMode: HostProviderAuthMode
    let maxOutputTokens: Int?
    let maxToolRounds: Int?
    let apiKey: String?
}

struct HostProviderProfileDeletion: Decodable, Sendable {
    let profileId: String
    let deleted: Bool
}

struct PairingGrant: Decodable, Sendable {
    let credentialSecret: String
    let deviceId: String
}

struct LocalHostPairingRequest: Encodable, Sendable {
    let pairingToken: String
    let deviceLabel = "Aru Host Console"
    let deviceRole = "host-console"
}

struct HostAPIError: Decodable, Sendable {
    let message: String?
    let error: String?
}

enum HostConsolePhase: Equatable {
    case selectingHost([String])
    case preparingHost
    case loading
    case ready
    case credentialFailure(String)
    case failure(String)
}

enum HostConsoleModelError: LocalizedError, Equatable {
    case invalidManifestSchema
    case invalidDriverSchema
    case invalidCollaboratorSchema

    var errorDescription: String? {
        switch self {
        case .invalidManifestSchema: L10n.invalidManifest
        case .invalidDriverSchema: L10n.invalidDrivers
        case .invalidCollaboratorSchema: L10n.invalidCollaborators
        }
    }
}

extension HostManifest {
    func validate() throws {
        guard schema == "aru.selfhost.manifest.v1" else {
            throw HostConsoleModelError.invalidManifestSchema
        }
    }
}

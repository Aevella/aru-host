import Foundation

struct HostManifest: Decodable, Equatable, Sendable {
    struct Capability: Decodable, Equatable, Sendable {
        let enabled: Bool
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

struct HostNodeSettings: Decodable, Equatable, Sendable {
    let schema: String
    let displayName: String
    let revision: Int
    let updatedAt: Int64
}

struct HostNodeSettingsUpdate: Encodable, Sendable {
    let schema = "aru.selfhost.node-settings.v1"
    let displayName: String
    let expectedRevision: Int
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

struct BackupPackageMetadata: Decodable, Equatable, Sendable {
    let sourceName: String
    let createdAt: Int64
    let packageByteCount: Int64
    let objectCounts: [String: Int]
    let binaryCount: Int
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

struct HostPluginPermissions: Codable, Equatable, Sendable {
    let network: String
    let persistentVolume: Bool
    let secretHandles: [String]
    let hostPaths: [String]
    let deviceAccess: Bool
}

struct HostPluginResources: Codable, Equatable, Sendable {
    let memoryMiB: Int?
    let cpuMillis: Int?
    let pids: Int?
}

struct HostPluginManifest: Decodable, Equatable, Sendable {
    let schema: String
    let pluginId: String
    let displayName: String
    let version: String
    let publisher: String
    let source: String
    let packageMode: String
    let image: String
    let protocols: [String]
    let permissions: HostPluginPermissions
    let resources: HostPluginResources
}

indirect enum HostJSONValue: Codable, Equatable, Sendable {
    case object([String: HostJSONValue])
    case array([HostJSONValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([HostJSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: HostJSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var prettyPrinted: String {
        guard let data = try? JSONEncoder.pretty.encode(self),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }
}

private extension JSONEncoder {
    static let pretty: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()
}

struct MCPToolAnnotations: Decodable, Equatable, Sendable {
    let readOnlyHint: Bool?
    let destructiveHint: Bool?
    let idempotentHint: Bool?
    let openWorldHint: Bool?
}

struct HostPluginEvent: Decodable, Equatable, Identifiable, Sendable {
    let schema: String
    let eventId: String
    let action: String
    let result: String
    let message: String
    let version: String
    let deviceId: String
    let createdAt: Int64

    var id: String { eventId }
}

struct HostPlugin: Decodable, Equatable, Identifiable, Sendable {
    let pluginId: String
    let manifest: HostPluginManifest
    let desiredState: String
    let health: String
    let rollbackAvailable: Bool
    let dataPresent: Bool
    let lastErrorCode: String?
    let lastErrorMessage: String?
    let tools: [MCPToolSummary]
    let installedAt: Int64
    let updatedAt: Int64
    let events: [HostPluginEvent]

    var id: String { pluginId }
}

struct HostPluginInventory: Decodable, Equatable, Sendable {
    let schema: String
    let plugins: [HostPlugin]
}

struct HostPluginDraft: Decodable, Equatable, Identifiable, Sendable {
    let schema: String
    let pluginId: String
    let displayName: String
    let version: String
    let sourceCode: String?
    let capabilities: [String]
    let permissions: HostPluginPermissions
    let digest: String
    let tools: [MCPToolSummary]
    let target: String
    let installedVersion: String?
    let createdAt: Int64
    let updatedAt: Int64

    var id: String { pluginId }
}

struct HostPluginDraftInventory: Decodable, Equatable, Sendable {
    let schema: String
    let drafts: [HostPluginDraft]
}

struct HostPluginSource: Decodable, Equatable, Sendable {
    let schema: String
    let pluginId: String
    let displayName: String
    let version: String
    let sourceCode: String
    let capabilities: [String]
    let digest: String
    let tools: [MCPToolSummary]
}

struct HostPluginSourceMutation: Encodable, Equatable, Sendable {
    let pluginId: String
    let displayName: String
    let version: String
    let sourceCode: String
    let capabilities: [String]
}

struct HostPluginValidationResult: Decodable, Equatable, Sendable {
    let digest: String
    let tools: [MCPToolSummary]
    let permissions: HostPluginPermissions
    let capabilities: [String]
}

struct HostPluginApplyResult: Decodable, Equatable, Sendable {
    let schema: String
    let plugin: HostPlugin
    let tools: [MCPToolSummary]
}

struct HostPluginDraftDeletion: Decodable, Equatable, Sendable {
    let pluginId: String
    let deleted: Bool
}

struct HostPluginUninstallResult: Decodable, Equatable, Sendable {
    let pluginId: String
    let dataDeleted: Bool
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

enum AgentDriverStatus: String, Decodable, Equatable, Sendable {
    case ready
    case unavailable
    case unhealthy

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unhealthy
    }
}

struct AgentDriver: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let displayName: String
    let adapter: String?
    let status: AgentDriverStatus
    let version: String?
    let failure: String?
}

struct AgentDriverExecution: Decodable, Equatable, Sendable {
    let enabled: Bool
    let status: String
    let conversationCount: Int?
    let activeTurnCount: Int?
    let pendingApprovalCount: Int?
}

struct AgentDriverInventory: Decodable, Equatable, Sendable {
    let schema: String
    let refreshedAt: Int64?
    let drivers: [AgentDriver]
    let execution: AgentDriverExecution
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

enum HostedCollaboratorToolAccessMode: String, Codable, Equatable, Sendable {
    case all
    case selected
}

struct HostedCollaboratorToolAccess: Codable, Equatable, Sendable {
    let schema: String
    let mode: HostedCollaboratorToolAccessMode
    let toolNames: [String]

    static let all = HostedCollaboratorToolAccess(
        schema: "aru.selfhost.collaborator-tool-access.v1",
        mode: .all,
        toolNames: []
    )

    static func selected(_ toolNames: Set<String>) -> HostedCollaboratorToolAccess {
        HostedCollaboratorToolAccess(
            schema: "aru.selfhost.collaborator-tool-access.v1",
            mode: .selected,
            toolNames: toolNames.sorted()
        )
    }

    func admits(_ toolName: String) -> Bool {
        mode == .all || toolNames.contains(toolName)
    }
}

struct HostedCollaborator: Decodable, Equatable, Identifiable, Sendable {
    let collaboratorId: String
    let displayName: String
    let driverId: String
    let providerProfileId: String?
    let revision: Int
    let activationStatus: String
    let turnExecution: Bool
    let toolAccess: HostedCollaboratorToolAccess
    let cognition: HostCollaboratorCognitionSummary?

    var id: String { collaboratorId }
}

enum HostCollaboratorInstructionEnvironment: String, Codable, Equatable, Sendable {
    case isolated
    case inheritCodex
}

enum HostCollaboratorCognitionRecordKind: String, Sendable {
    case memories
    case references
}

struct HostCollaboratorCognitionSummary: Decodable, Equatable, Sendable {
    let schema: String
    let revision: Int
    let instructionEnvironment: HostCollaboratorInstructionEnvironment
    let hasSystemPrompt: Bool
    let memoryCount: Int
    let referenceCount: Int
    let updatedAt: Int64
}

struct HostCollaboratorMemory: Decodable, Equatable, Identifiable, Sendable {
    let memoryId: String
    let title: String
    let content: String
    let createdAt: Int64
    let updatedAt: Int64
    let archivedAt: Int64?

    var id: String { memoryId }
    var isArchived: Bool { archivedAt != nil }
}

struct HostCollaboratorReference: Decodable, Equatable, Identifiable, Sendable {
    let referenceId: String
    let title: String
    let content: String
    let createdAt: Int64
    let updatedAt: Int64
    let archivedAt: Int64?

    var id: String { referenceId }
    var isArchived: Bool { archivedAt != nil }
}

struct HostCollaboratorCognition: Decodable, Equatable, Sendable {
    let schema: String
    let collaboratorId: String
    let revision: Int
    let instructionEnvironment: HostCollaboratorInstructionEnvironment
    let systemPrompt: String
    let memories: [HostCollaboratorMemory]
    let references: [HostCollaboratorReference]
    let createdAt: Int64
    let updatedAt: Int64
}

struct HostCollaboratorInitiativeRule: Decodable, Equatable, Identifiable, Sendable {
    let ruleId: String
    let title: String
    let goal: String
    let instructions: String
    let conversationId: String?
    let nextFireAt: Int64?
    let recurrenceMinutes: Int?
    let notificationsEnabled: Bool
    let enabled: Bool
    let deliveryCount: Int
    let lastAttemptAt: Int64?
    let lastDeliveredAt: Int64?
    let lastFailure: String?
    let runningAt: Int64?
    let createdAt: Int64
    let updatedAt: Int64
    let archivedAt: Int64?

    var id: String { ruleId }
    var isArchived: Bool { archivedAt != nil }
    var isRunning: Bool { runningAt != nil }
}

struct HostCollaboratorInitiative: Decodable, Equatable, Sendable {
    let schema: String
    let collaboratorId: String
    let revision: Int
    let rules: [HostCollaboratorInitiativeRule]
    let createdAt: Int64
    let updatedAt: Int64
}

struct CreateHostCollaboratorInitiativeRuleBody: Encodable, Sendable {
    let expectedRevision: Int
    let title: String
    let goal: String
    let instructions: String
    let nextFireAt: Int64
    let recurrenceMinutes: Int?
    let notificationsEnabled: Bool
    let enabled: Bool
}

struct UpdateHostCollaboratorInitiativeRuleBody: Encodable, Sendable {
    let expectedRevision: Int
    let enabled: Bool
}

struct MutateHostCollaboratorInitiativeRuleBody: Encodable, Sendable {
    let expectedRevision: Int
}

struct UpdateHostCollaboratorCognitionBody: Encodable, Sendable {
    let expectedRevision: Int
    let instructionEnvironment: HostCollaboratorInstructionEnvironment
    let systemPrompt: String
}

struct MutateHostCollaboratorCognitionRecordBody: Encodable, Sendable {
    let expectedRevision: Int
    let title: String
    let content: String
}

struct ArchiveHostCollaboratorCognitionRecordBody: Encodable, Sendable {
    let expectedRevision: Int
}

struct HostedCollaboratorInventory: Decodable, Equatable, Sendable {
    let schema: String
    let collaborators: [HostedCollaborator]
}

struct HostCollaboratorConversationTurn: Decodable, Equatable, Sendable {
    let turnId: String
    let state: String
    let userMessageId: String
    let assistantMessageId: String
    let createdAt: Int64
    let startedAt: Int64?
    let completedAt: Int64?
    let failure: String?

    var isActive: Bool {
        ["queued", "starting", "streaming", "waitingApproval", "toolRunning"].contains(state)
    }
}

struct HostCollaboratorConversationMessage: Decodable, Equatable, Identifiable, Sendable {
    let messageId: String
    let role: String
    let content: String
    let status: String
    let createdAt: Int64
    let updatedAt: Int64

    var id: String { messageId }
}

struct HostCollaboratorConversationApproval: Decodable, Equatable, Identifiable, Sendable {
    let approvalId: String
    let turnId: String
    let kind: String
    let title: String
    let detail: [String: HostJSONValue]
    let state: String
    let decision: String?
    let createdAt: Int64
    let resolvedAt: Int64?

    var id: String { approvalId }
    var isPending: Bool { state == "pending" }
}

struct HostCollaboratorConversation: Decodable, Equatable, Identifiable, Sendable {
    let schema: String
    let conversationId: String
    let collaboratorId: String
    let title: String
    let revision: Int
    let createdAt: Int64
    let updatedAt: Int64
    let archivedAt: Int64?
    let cursor: Int
    let activeTurn: HostCollaboratorConversationTurn?
    let messageCount: Int
    let pendingApprovalCount: Int
    let lastMessagePreview: String
    let messages: [HostCollaboratorConversationMessage]?
    let approvals: [HostCollaboratorConversationApproval]?

    var id: String { conversationId }
}

struct HostCollaboratorConversationInventory: Decodable, Equatable, Sendable {
    let schema: String
    let collaboratorId: String
    let conversations: [HostCollaboratorConversation]
}

struct CreateHostCollaboratorConversationBody: Encodable, Sendable {
    let title: String?
}

struct SendHostCollaboratorConversationMessageBody: Encodable, Sendable {
    let clientRequestId: String
    let text: String
}

struct ResolveHostCollaboratorConversationApprovalBody: Encodable, Sendable {
    let decision: String
}

struct HostCollaboratorSurfaceVersion: Decodable, Equatable, Identifiable, Sendable {
    let versionId: String
    let ordinal: Int
    let contentSHA256: String
    let note: String
    let createdAt: Int64
    let restoredFromVersionId: String?
    let delivery: String?
    let projectPath: String?
    let entryPath: String?
    let files: [HostCollaboratorSurfaceFile]?
    let byteCount: Int?

    var id: String { versionId }
}

struct HostCollaboratorSurface: Decodable, Equatable, Identifiable, Sendable {
    let surfaceId: String
    let collaboratorId: String
    let title: String
    let revision: Int
    let activeVersionId: String
    let activeVersionOrdinal: Int
    let contentSHA256: String
    let createdAt: Int64
    let updatedAt: Int64
    let archivedAt: Int64?
    let stateRevision: Int
    let stateUpdatedAt: Int64
    let eventCount: Int
    let sourceHTML: String?
    let stateJSON: String?
    let versions: [HostCollaboratorSurfaceVersion]?
    let delivery: String?
    let projectPath: String?
    let entryPath: String?
    let files: [HostCollaboratorSurfaceFile]?
    let byteCount: Int?
    let networkAccess: String?
    let storageMode: String?

    var id: String { surfaceId }
    var isArchived: Bool { archivedAt != nil }
    var allowsOutboundNetwork: Bool { networkAccess == "outbound" }
}

struct HostCollaboratorSurfaceFile: Decodable, Equatable, Identifiable, Sendable {
    let path: String
    let sha256: String
    let byteCount: Int
    let mimeType: String

    var id: String { path }
}

struct HostCollaboratorSurfaceBundleFile: Decodable, Equatable, Identifiable, Sendable {
    let path: String
    let sha256: String
    let byteCount: Int
    let mimeType: String
    let contentBase64: String

    var id: String { path }
    var data: Data? { Data(base64Encoded: contentBase64) }
}

struct HostCollaboratorSurfaceBundle: Decodable, Equatable, Sendable {
    let schema: String
    let collaboratorId: String
    let surfaceId: String
    let versionId: String
    let contentSHA256: String
    let entryPath: String
    let byteCount: Int
    let files: [HostCollaboratorSurfaceBundleFile]
}

struct HostCollaboratorSurfaceInventory: Decodable, Sendable {
    let schema: String
    let collaboratorId: String
    let surfaces: [HostCollaboratorSurface]
}

struct HostCollaboratorProjectRepository: Decodable, Equatable, Sendable {
    let state: String
    let sourceURL: String?
    let repositoryURL: String?
    let branch: String?
    let commit: String?
    let dirty: Bool?
    let upstream: String?
    let ahead: Int?
    let behind: Int?
}

struct HostCollaboratorProjectCheckpoint: Decodable, Equatable, Sendable {
    let checkpointId: String
    let ordinal: Int
    let note: String
    let artifactId: String
    let createdAt: Int64
}

struct HostCollaboratorProject: Decodable, Equatable, Identifiable, Sendable {
    let schema: String
    let projectId: String
    let collaboratorId: String
    let title: String
    let revision: Int
    let workspacePath: String
    let entryPath: String
    let sourceURL: String?
    let repositoryURL: String?
    let surfaceId: String?
    let checkpointCount: Int
    let latestCheckpoint: HostCollaboratorProjectCheckpoint?
    let createdAt: Int64
    let updatedAt: Int64
    let archivedAt: Int64?
    let repository: HostCollaboratorProjectRepository?

    var id: String { projectId }
    var isArchived: Bool { archivedAt != nil }
}

struct HostCollaboratorProjectInventory: Decodable, Sendable {
    let schema: String
    let collaboratorId: String
    let projects: [HostCollaboratorProject]
}

struct HostCollaboratorProjectCheckpointReceipt: Decodable, Sendable {
    let project: HostCollaboratorProject
    let artifact: HostArtifact
}

struct HostCollaboratorProjectPublishReceipt: Decodable, Sendable {
    let project: HostCollaboratorProject
    let surface: HostCollaboratorSurface
}

struct CreateHostCollaboratorProjectBody: Encodable, Sendable {
    let title: String
    let repositoryURL: String?
    let entryPath: String
}

struct CheckpointHostCollaboratorProjectBody: Encodable, Sendable {
    let expectedRevision: Int
    let note: String
}

struct PublishHostCollaboratorProjectBody: Encodable, Sendable {
    let expectedRevision: Int
    let expectedSurfaceRevision: Int?
    let note: String
    let networkAccess: String
}

struct CreateHostCollaboratorSurfaceBody: Encodable, Sendable {
    let title: String
    let sourceHTML: String
    let note: String
    let networkAccess: String
}

struct UpdateHostCollaboratorSurfaceBody: Encodable, Sendable {
    let expectedRevision: Int
    let title: String
    let sourceHTML: String
    let note: String
    let networkAccess: String
}

struct UpdateHostCollaboratorSurfaceRuntimeBody: Encodable, Sendable {
    let expectedRevision: Int
    let networkAccess: String
}

struct RollbackHostCollaboratorSurfaceBody: Encodable, Sendable {
    let expectedRevision: Int
    let versionId: String
    let note: String
}

struct ArchiveHostCollaboratorSurfaceBody: Encodable, Sendable {
    let expectedRevision: Int
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

struct CreateHostedCollaboratorBody: Encodable, Sendable {
    let displayName: String
    let driverId: String
    let providerProfileId: String?
}

struct UpdateHostedCollaboratorDriverBody: Encodable, Sendable {
    let expectedRevision: Int
    let driverId: String
    let providerProfileId: String?
}

struct UpdateHostedCollaboratorToolAccessBody: Encodable, Sendable {
    let expectedRevision: Int
    let toolAccess: HostedCollaboratorToolAccess
}

enum HostConsolePhase: Equatable {
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

extension AgentDriverInventory {
    func validate() throws {
        guard schema == "aru.selfhost.agent-driver-inventory.v1" else {
            throw HostConsoleModelError.invalidDriverSchema
        }
    }
}

extension HostedCollaboratorInventory {
    func validate() throws {
        guard schema == "aru.selfhost.hosted-collaborator-inventory.v1",
              collaborators.allSatisfy({ $0.toolAccess.schema == "aru.selfhost.collaborator-tool-access.v1" }) else {
            throw HostConsoleModelError.invalidCollaboratorSchema
        }
    }
}

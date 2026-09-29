import Foundation

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
}

struct AgentDriverInventory: Decodable, Equatable, Sendable {
    let schema: String
    let refreshedAt: Int64?
    let drivers: [AgentDriver]
    let execution: AgentDriverExecution
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

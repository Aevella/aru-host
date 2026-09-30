import Foundation

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

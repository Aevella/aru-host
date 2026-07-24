import Foundation
import Testing
@testable import AruHostConsole

@Test func readsBundledHostReleaseVersionFromInstallerState() {
    #expect(BundledHostCoreInstaller.installedReleaseVersion(in: "ARU_INSTALL_RELEASE_VERSION=0.28.0\n") == "0.28.0")
    #expect(BundledHostCoreInstaller.installedReleaseVersion(in: "ARU_INSTALL_RELEASE_VERSION='0.28.1'\n") == "0.28.1")
    #expect(BundledHostCoreInstaller.installedReleaseVersion(in: "ARU_INSTALL_SOURCE_REF=main\n") == nil)
}

@Test func comparesStableAndPrereleaseHostVersions() {
    #expect(HostSemanticVersion.isNewer("0.28.1", than: "0.28.0"))
    #expect(HostSemanticVersion.isNewer("0.28.0", than: "0.28.0-dev"))
    #expect(!HostSemanticVersion.isNewer("0.28.0", than: "0.28.0"))
    #expect(!HostSemanticVersion.isNewer("0.27.9", than: "0.28.0"))
    #expect(!HostSemanticVersion.isNewer("latest", than: "0.28.0"))
}

@Test func visibleHostSectionsOwnAutomaticRefreshCadence() {
    #expect(HostConsoleSection.runtime.automaticRefreshSeconds == 3)
    #expect(HostConsoleSection.collaborators.automaticRefreshSeconds == 8)
    #expect(HostConsoleSection.mcp.automaticRefreshSeconds == 15)
    #expect(HostConsoleSection.allCases.allSatisfy { $0.automaticRefreshSeconds > 0 })
}

@Test func extractsOnlyCompletePairingLinksFromControlOutput() {
    let link = "aru://pair?canonicalUrl=http://example-mac.local:8787&serverId=home-mac&pairingToken=secret"
    #expect(LocalPairingIssuer.pairingLink(from: "restarting\n\(link)\nready") == link)
    #expect(LocalPairingIssuer.pairingLink(from: "aru://pair?serverId=home-mac") == nil)
    #expect(LocalPairingIssuer.pairingLink(from: "https://example.com") == nil)
}

@Test func decodesCurrentHostControlPlaneShapes() throws {
    let drivers = try JSONDecoder().decode(AgentDriverInventory.self, from: Data(#"""
    {
      "schema":"aru.selfhost.agent-driver-inventory.v1",
      "refreshedAt":1784090000000,
      "drivers":[
        {"id":"codex","displayName":"Codex","status":"ready","version":"codex-cli 0.144.0","failure":null},
        {"id":"claude-code","displayName":"Claude Code","status":"unavailable","version":null,"failure":"command-not-found"}
      ],
      "execution":{"enabled":false,"status":"driver-control-plane-only"}
    }
    """#.utf8))
    try drivers.validate()
    #expect(drivers.drivers.count == 2)
    #expect(drivers.drivers.first?.status == .ready)
    #expect(drivers.execution.enabled == false)

    let roots = try JSONDecoder().decode(HostedCollaboratorInventory.self, from: Data(#"""
    {"schema":"aru.selfhost.hosted-collaborator-inventory.v1","collaborators":[]}
    """#.utf8))
    try roots.validate()
    #expect(roots.collaborators.isEmpty)
}

@Test @MainActor func computerCollaboratorAvatarMatchesAruStablePresetRule() {
    #expect(HostCollaboratorAvatarPreset.count == 36)
    #expect(HostCollaboratorAvatarPreset.assetName(for: "hostcol_1")
            == "AvatarPresetCollaborator04")
    #expect(HostCollaboratorAvatarPreset.assetName(for: "hostcol_1")
            == HostCollaboratorAvatarPreset.assetName(for: "hostcol_1"))
    #expect(HostCollaboratorAvatarPreset.resourceURL(for: "hostcol_1") != nil)
    #expect(HostCollaboratorAvatarPreset.image(for: "hostcol_1") != nil)
}

@Test func decodesCollaboratorSurfaceProjectBundle() throws {
    let surface = try JSONDecoder().decode(HostCollaboratorSurface.self, from: Data(#"""
    {
      "schema":"aru.selfhost.collaborator-surface.v1",
      "surfaceId":"surface_1",
      "collaboratorId":"hostcol_1",
      "title":"Aelion's room",
      "revision":2,
      "activeVersionId":"version_2",
      "activeVersionOrdinal":2,
      "contentSHA256":"releasehash",
      "createdAt":100,
      "updatedAt":200,
      "archivedAt":null,
      "stateRevision":0,
      "stateUpdatedAt":200,
      "eventCount":0,
      "sourceHTML":null,
      "stateJSON":"{}",
      "delivery":"bundle",
      "projectPath":"pages/room",
      "entryPath":"index.html",
      "byteCount":24,
      "files":[{"path":"index.html","sha256":"htmlhash","byteCount":12,"mimeType":"text/html"}],
      "versions":[]
    }
    """#.utf8))
    #expect(surface.delivery == "bundle")
    #expect(surface.files?.first?.path == "index.html")

    let bundle = try JSONDecoder().decode(HostCollaboratorSurfaceBundle.self, from: Data(#"""
    {
      "schema":"aru.selfhost.collaborator-surface-bundle.v1",
      "collaboratorId":"hostcol_1",
      "surfaceId":"surface_1",
      "versionId":"version_2",
      "contentSHA256":"releasehash",
      "entryPath":"index.html",
      "byteCount":12,
      "files":[{"path":"index.html","sha256":"htmlhash","byteCount":12,"mimeType":"text/html","contentBase64":"PGgxPkFydTwvaDE+"}]
    }
    """#.utf8))
    #expect(String(data: try #require(bundle.files.first?.data), encoding: .utf8) == "<h1>Aru</h1>")
}

@Test func rejectsUnknownWireSchema() throws {
    let roots = try JSONDecoder().decode(HostedCollaboratorInventory.self, from: Data(#"""
    {"schema":"aru.selfhost.hosted-collaborator-inventory.v2","collaborators":[]}
    """#.utf8))
    #expect(throws: HostConsoleModelError.invalidCollaboratorSchema) {
        try roots.validate()
    }
}

@Test func decodesComputerCollaboratorCognitionControlPlane() throws {
    let cognition = try JSONDecoder().decode(HostCollaboratorCognition.self, from: Data(#"""
    {
      "schema":"aru.selfhost.collaborator-cognition.v1",
      "collaboratorId":"hostcol_1234",
      "revision":4,
      "instructionEnvironment":"inheritCodex",
      "systemPrompt":"Keep the collaborator identity explicit.",
      "memories":[{
        "memoryId":"hostmem_1",
        "title":"Preferred name",
        "content":"Use AA when invited.",
        "createdAt":100,
        "updatedAt":110,
        "archivedAt":null
      }],
      "references":[{
        "referenceId":"hostref_1",
        "title":"Project boundary",
        "content":"Host remains the durable authority.",
        "createdAt":120,
        "updatedAt":130,
        "archivedAt":140
      }],
      "createdAt":90,
      "updatedAt":140
    }
    """#.utf8))

    #expect(cognition.collaboratorId == "hostcol_1234")
    #expect(cognition.instructionEnvironment == .inheritCodex)
    #expect(cognition.memories.first?.isArchived == false)
    #expect(cognition.references.first?.isArchived == true)
    #expect(HostCollaboratorCognitionRecordKind.memories.rawValue == "memories")
    #expect(HostCollaboratorCognitionRecordKind.references.rawValue == "references")
}

@Test func decodesCollaboratorToolAccessAndAdmission() throws {
    let roots = try JSONDecoder().decode(HostedCollaboratorInventory.self, from: Data(#"""
    {
      "schema":"aru.selfhost.hosted-collaborator-inventory.v1",
      "collaborators":[{
        "collaboratorId":"hostcol_1234",
        "displayName":"Aelion",
        "driverId":"codex",
        "revision":3,
        "activationStatus":"driver-ready",
        "turnExecution":false,
        "toolAccess":{
          "schema":"aru.selfhost.collaborator-tool-access.v1",
          "mode":"selected",
          "toolNames":["aru_node_status","plugin__notes__remember"]
        }
      }]
    }
    """#.utf8))
    try roots.validate()
    let collaborator = try #require(roots.collaborators.first)
    #expect(collaborator.toolAccess.admits("aru_node_status"))
    #expect(!collaborator.toolAccess.admits("aru_node_rename"))
    #expect(HostedCollaboratorToolAccess.all.admits("a_future_plugin_tool"))
    #expect(HostedCollaboratorToolAccess.selected(["b", "a"]).toolNames == ["a", "b"])
}

@Test func decodesDirectProviderProfilesAndCollaboratorBinding() throws {
    let inventory = try JSONDecoder().decode(HostProviderProfileInventory.self, from: Data(#"""
    {
      "schema":"aru.selfhost.provider-profile-inventory.v1",
      "secretStorage":{"supported":true,"storage":"macos-keychain","failure":null},
      "profiles":[{
        "schema":"aru.selfhost.provider-profile.v1",
        "profileId":"provider_1234",
        "displayName":"Home API",
        "protocol":"openai-compatible",
        "baseURL":"https://api.example.test/",
        "path":"v1/chat/completions",
        "model":"aru-model",
        "authMode":"bearer",
        "maxToolRounds":12,
        "revision":2,
        "createdAt":100,
        "updatedAt":200,
        "health":"ready",
        "lastCheckedAt":210,
        "lastError":null,
        "hasSecret":true
      }]
    }
    """#.utf8))
    let profile = try #require(inventory.profiles.first)
    #expect(inventory.secretStorage.storage == "macos-keychain")
    #expect(profile.protocol == .openAICompatible)
    #expect(profile.health == .ready)
    #expect(profile.hasSecret)
    #expect(profile.maxToolRounds == 12)

    let roots = try JSONDecoder().decode(HostedCollaboratorInventory.self, from: Data(#"""
    {
      "schema":"aru.selfhost.hosted-collaborator-inventory.v1",
      "collaborators":[{
        "collaboratorId":"hostcol_1234",
        "displayName":"Example Collaborator",
        "driverId":"api",
        "providerProfileId":"provider_1234",
        "revision":1,
        "activationStatus":"driver-ready",
        "turnExecution":true,
        "toolAccess":{"schema":"aru.selfhost.collaborator-tool-access.v1","mode":"all","toolNames":[]}
      }]
    }
    """#.utf8))
    #expect(roots.collaborators.first?.providerProfileId == "provider_1234")
    #expect(roots.collaborators.first?.turnExecution == true)
}

@Test func decodesComputerCollaboratorSurfaceControlPlane() throws {
    let inventory = try JSONDecoder().decode(HostCollaboratorSurfaceInventory.self, from: Data(#"""
    {
      "schema":"aru.selfhost.collaborator-surface-inventory.v1",
      "collaboratorId":"hostcol_1234",
      "surfaces":[{
        "schema":"aru.selfhost.collaborator-surface.v1",
        "surfaceId":"surface_1234",
        "collaboratorId":"hostcol_1234",
        "title":"Aelion's desk",
        "revision":4,
        "activeVersionId":"surfacever_2",
        "activeVersionOrdinal":2,
        "contentSHA256":"abc123",
        "createdAt":100,
        "updatedAt":200,
        "archivedAt":null,
        "stateRevision":3,
        "stateUpdatedAt":220,
        "eventCount":7,
        "networkAccess":"outbound",
        "storageMode":"isolated-persistent"
      }]
    }
    """#.utf8))
    #expect(inventory.collaboratorId == "hostcol_1234")
    #expect(inventory.surfaces.first?.activeVersionOrdinal == 2)
    #expect(inventory.surfaces.first?.eventCount == 7)
    #expect(inventory.surfaces.first?.allowsOutboundNetwork == true)

    let detail = try JSONDecoder().decode(HostCollaboratorSurface.self, from: Data(#"""
    {
      "schema":"aru.selfhost.collaborator-surface.v1",
      "surfaceId":"surface_1234",
      "collaboratorId":"hostcol_1234",
      "title":"Aelion's desk",
      "revision":4,
      "activeVersionId":"surfacever_2",
      "activeVersionOrdinal":2,
      "contentSHA256":"abc123",
      "createdAt":100,
      "updatedAt":200,
      "archivedAt":null,
      "stateRevision":3,
      "stateUpdatedAt":220,
      "eventCount":7,
      "networkAccess":"outbound",
      "storageMode":"isolated-persistent",
      "sourceHTML":"<main>Hello</main>",
      "stateJSON":"{\"open\":true}",
      "versions":[{
        "schema":"aru.selfhost.collaborator-surface-version.v1",
        "versionId":"surfacever_2",
        "ordinal":2,
        "contentSHA256":"abc123",
        "note":"Current",
        "createdAt":200,
        "restoredFromVersionId":null
      }]
    }
    """#.utf8))
    #expect(detail.sourceHTML == "<main>Hello</main>")
    #expect(detail.stateJSON == #"{"open":true}"#)
    #expect(detail.versions?.first?.note == "Current")
    #expect(detail.allowsOutboundNetwork)
}

@Test func decodesComputerCollaboratorConversationControlPlane() throws {
    let detail = try JSONDecoder().decode(HostCollaboratorConversation.self, from: Data(#"""
    {
      "schema":"aru.selfhost.collaborator-conversation.v1",
      "conversationId":"hostconv_1234",
      "collaboratorId":"hostcol_1234",
      "title":"Ship the runner",
      "revision":4,
      "createdAt":100,
      "updatedAt":200,
      "archivedAt":null,
      "cursor":9,
      "activeTurn":{"turnId":"hostturn_1","state":"waitingApproval","userMessageId":"m1","assistantMessageId":"m2","createdAt":100,"startedAt":110,"completedAt":null,"failure":null},
      "messageCount":2,
      "pendingApprovalCount":1,
      "lastMessagePreview":"",
      "messages":[
        {"messageId":"m1","role":"user","content":"Ship it","status":"completed","createdAt":100,"updatedAt":100},
        {"messageId":"m2","role":"assistant","content":"","status":"streaming","createdAt":100,"updatedAt":100}
      ],
      "approvals":[{
        "approvalId":"hostapproval_1","turnId":"hostturn_1","kind":"command","title":"Allow command?",
        "detail":{"command":"swift test"},"state":"pending","decision":null,"createdAt":120,"resolvedAt":null
      }]
    }
    """#.utf8))
    #expect(detail.activeTurn?.isActive == true)
    #expect(detail.approvals?.first?.isPending == true)
    #expect(detail.approvals?.first?.detail["command"] == .string("swift test"))
}

@Test func decodesBackupAndRuntimeInventories() throws {
    let backup = try JSONDecoder().decode(BackupInventory.self, from: Data(#"""
    {
      "packages":[{
        "remotePackageId":"r_12345678",
        "uploadedAt":1784094390044,
        "metadata":{
          "sourceName":"Aru Scheduled Backup",
          "createdAt":1784094357772,
          "packageByteCount":447409506,
          "objectCounts":{"conversations":651,"messages":11056},
          "binaryCount":206
        }
      }]
    }
    """#.utf8))
    #expect(backup.packages.first?.metadata.packageByteCount == 447_409_506)
    #expect(backup.packages.first?.metadata.objectCounts["messages"] == 11_056)

    let backupSettings = try JSONDecoder().decode(HostBackupSettings.self, from: Data(#"""
    {"schema":"aru.selfhost.backup-settings.v1","retentionMode":"keep-latest","keepLatestCount":30,"revision":3,"updatedAt":1784094390044,"lastAppliedAt":1784094400044,"lastDeletedCount":2}
    """#.utf8))
    #expect(backupSettings.retentionMode == .keepLatest)
    #expect(backupSettings.keepLatestCount == 30)
    #expect(backupSettings.lastDeletedCount == 2)

    let policy = try JSONDecoder().decode(HostWorkspaceJobPolicy.self, from: Data(#"""
    {"schema":"aru.selfhost.workspace-job-policy.v1","defaultMaximumRuntimeSeconds":86400,"updatedAt":1784089548352}
    """#.utf8))
    #expect(policy.defaultMaximumRuntimeSeconds == 86_400)
}

@Test func decodesMCPGatewayCatalog() throws {
    let initialized = try JSONDecoder().decode(MCPInitializeEnvelope.self, from: Data(#"""
    {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"Aru Self-Hosted MCP Gateway","version":"stub-0.14"}}}
    """#.utf8))
    #expect(initialized.result.serverInfo.name == "Aru Self-Hosted MCP Gateway")

    let tools = try JSONDecoder().decode(MCPToolsEnvelope.self, from: Data(#"""
    {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"aru_node_status","description":"Read node status","inputSchema":{"type":"object"}}]}}
    """#.utf8))
    #expect(tools.result.tools.map(\.name) == ["aru_node_status"])
}

@Test func decodesVisiblePluginWorkshopLifecycle() throws {
    let inventory = try JSONDecoder().decode(HostPluginInventory.self, from: Data(#"""
    {
      "schema":"aru.selfhost.plugin-inventory.v1",
      "plugins":[{
        "schema":"aru.selfhost.plugin.v1",
        "pluginId":"workshop.notes",
        "manifest":{
          "schema":"aru.selfhost.plugin-manifest.v1",
          "pluginId":"workshop.notes",
          "displayName":"Notes",
          "version":"1.2.0",
          "publisher":"Aru workshop",
          "source":"model-authored-on-paired-node",
          "packageMode":"source-node",
          "image":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "protocols":["mcp-tools-v1"],
          "permissions":{"network":"none","persistentVolume":true,"secretHandles":[],"hostPaths":[],"deviceAccess":false},
          "resources":{"memoryMiB":null,"cpuMillis":null,"pids":null}
        },
        "grantedPermissions":{"network":"none","persistentVolume":true,"secretHandles":[],"hostPaths":[],"deviceAccess":false},
        "desiredState":"enabled",
        "health":"running",
        "rollbackAvailable":true,
        "dataPresent":true,
        "tools":[{"name":"remember","title":"Remember","description":"Store a note","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}}],
        "installedAt":1784090000000,
        "updatedAt":1784090001000,
        "lastErrorCode":null,
        "lastErrorMessage":null,
        "events":[{"schema":"aru.selfhost.plugin-event.v1","eventId":"pe_1","action":"enabled","result":"succeeded","message":"Enabled","version":"1.2.0","deviceId":"dev_phone","createdAt":1784090001000}]
      }]
    }
    """#.utf8))
    let plugin = try #require(inventory.plugins.first)
    #expect(plugin.health == "running")
    #expect(plugin.manifest.permissions.persistentVolume)
    #expect(plugin.tools.first?.inputSchema.prettyPrinted.contains("text") == true)
    #expect(plugin.events.first?.action == "enabled")

    let drafts = try JSONDecoder().decode(HostPluginDraftInventory.self, from: Data(#"""
    {
      "schema":"aru.selfhost.plugin-draft-inventory.v1",
      "drafts":[{
        "schema":"aru.selfhost.plugin-draft.v1",
        "pluginId":"workshop.notes",
        "displayName":"Notes",
        "version":"1.3.0",
        "capabilities":["persistent-storage"],
        "permissions":{"network":"none","persistentVolume":true,"secretHandles":[],"hostPaths":[],"deviceAccess":false},
        "resources":{"memoryMiB":null,"cpuMillis":null,"pids":null},
        "digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "tools":[{"name":"remember","description":"Store a note","inputSchema":{"type":"object"}}],
        "target":"update",
        "installedVersion":"1.2.0",
        "createdAt":1784090000000,
        "updatedAt":1784090002000,
        "authoredByDeviceId":"dev_phone"
      }]
    }
    """#.utf8))
    #expect(drafts.drafts.first?.sourceCode == nil)
    #expect(drafts.drafts.first?.target == "update")
}

@Test func decodesHostOwnedComputerFolderInventory() throws {
    let inventory = try JSONDecoder().decode(HostNodeWorkspaceInventory.self, from: Data(#"""
    {
      "schema":"aru.selfhost.node-workspace-inventory.v1",
      "workspaces":[{
        "schema":"aru.selfhost.node-workspace.v1",
        "workspaceId":"projects",
        "displayName":"Projects",
        "rootDisplayPath":"~/Developer",
        "ownership":"host-managed",
        "isDefault":true,
        "permissions":["list","read-text","write-text"],
        "createdAt":1784090000000,
        "updatedAt":1784090000001
      }]
    }
    """#.utf8))

    #expect(inventory.schema == "aru.selfhost.node-workspace-inventory.v1")
    #expect(inventory.workspaces.first?.workspaceId == "projects")
    #expect(inventory.workspaces.first?.ownership == .hostManaged)
    #expect(inventory.workspaces.first?.isDefault == true)
    #expect(inventory.workspaces.first?.permissions.contains("write-text") == true)
    #expect(HostConsoleSection.allCases.contains(.workspaces))
}

@Test func decodesNodeIdentityAndAccessControlShapes() throws {
    let settings = try JSONDecoder().decode(HostNodeSettings.self, from: Data(#"""
    {"schema":"aru.selfhost.node-settings.v1","displayName":"Example Home Mac","revision":3,"updatedAt":1784090000000}
    """#.utf8))
    #expect(settings.displayName == "Example Home Mac")
    #expect(settings.revision == 3)

    let inventory = try JSONDecoder().decode(HostPairedDeviceInventory.self, from: Data(#"""
    {
      "schema":"aru.selfhost.paired-device-inventory.v1",
      "currentDeviceId":"dev_console",
      "devices":[
        {"deviceId":"dev_phone","label":"Example iPhone","issuedAt":1784080000000,"revokedAt":null,"isCurrent":false},
        {"deviceId":"dev_console","label":"Aru Host Console","issuedAt":1784090000000,"revokedAt":null,"isCurrent":true}
      ]
    }
    """#.utf8))
    #expect(inventory.devices.count == 2)
    #expect(inventory.devices.first(where: \.isCurrent)?.deviceId == "dev_console")
    #expect(inventory.devices.allSatisfy { $0.isActive })
}

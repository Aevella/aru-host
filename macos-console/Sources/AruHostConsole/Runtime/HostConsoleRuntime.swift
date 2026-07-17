import Foundation

@MainActor
final class HostConsoleRuntime: ObservableObject {
    @Published private(set) var phase: HostConsolePhase = .loading
    @Published private(set) var manifest: HostManifest?
    @Published private(set) var diagnostics: HostDiagnostics?
    @Published private(set) var nodeSettings: HostNodeSettings?
    @Published private(set) var pairedDevices: [HostPairedDevice] = []
    @Published private(set) var backups: [BackupPackage] = []
    @Published private(set) var backupSettings: HostBackupSettings?
    @Published private(set) var mcpGateway: MCPGatewaySnapshot?
    @Published private(set) var plugins: [HostPlugin] = []
    @Published private(set) var pluginDrafts: [HostPluginDraft] = []
    @Published private(set) var pluginActionMessage: String?
    @Published private(set) var pluginActionFailed = false
    @Published private(set) var workspaces: [HostNodeWorkspace] = []
    @Published private(set) var jobs: [HostWorkspaceJob] = []
    @Published private(set) var jobPolicy: HostWorkspaceJobPolicy?
    @Published private(set) var artifacts: [HostArtifact] = []
    @Published private(set) var driverInventory: AgentDriverInventory?
    @Published private(set) var collaborators: [HostedCollaborator] = []
    @Published private(set) var collaboratorSurfaces: [String: [HostCollaboratorSurface]] = [:]
    @Published private(set) var collaboratorConversations: [String: [HostCollaboratorConversation]] = [:]
    @Published private(set) var collaboratorConversationDetails: [String: HostCollaboratorConversation] = [:]
    @Published var collaboratorCognitions: [String: HostCollaboratorCognition] = [:]
    @Published private(set) var sectionErrors: [HostConsoleSection: String] = [:]
    @Published private(set) var loadingSections: Set<HostConsoleSection> = []
    @Published private(set) var mutatingPluginIds: Set<String> = []
    @Published private(set) var isRefreshing = false
    @Published private(set) var isPairing = false
    @Published private(set) var isCreatingCollaborator = false
    @Published private(set) var mutatingCollaboratorIds: Set<String> = []
    @Published private(set) var mutatingSurfaceIds: Set<String> = []
    @Published private(set) var mutatingConversationIds: Set<String> = []
    @Published var mutatingCognitionIds: Set<String> = []
    @Published private(set) var isUpdatingJobPolicy = false
    @Published private(set) var isUpdatingWorkspaces = false
    @Published private(set) var isUpdatingNodeSettings = false
    @Published private(set) var mutatingDeviceIds: Set<String> = []
    @Published private(set) var mutatingBackupIds: Set<String> = []
    @Published private(set) var isUpdatingBackupSettings = false
    @Published private(set) var lastUpdated: Date?

    private let session: URLSession
    private let vault: HostCredentialVault
    private let baseURL: URL
    private var credential: String?

    init(
        session: URLSession = .shared,
        vault: HostCredentialVault = HostCredentialVault(),
        baseURL: URL = LocalHostLocator.baseURL()
    ) {
        self.session = session
        self.vault = vault
        self.baseURL = baseURL
    }

    var readyDriverCount: Int {
        driverInventory?.drivers.filter { $0.status == .ready }.count ?? 0
    }

    var executionEnabled: Bool {
        driverInventory?.execution.enabled == true
    }

    func capability(_ id: String) -> HostManifest.Capability? {
        manifest?.capabilities[id]
    }

    func start() async {
        phase = .loading
        do {
            let manifest: HostManifest = try await request("/.well-known/aru.json")
            try manifest.validate()
            self.manifest = manifest
        } catch {
            phase = .failure(error.localizedDescription)
            return
        }
        do {
            credential = try vault.read()
        } catch {
            phase = .credentialFailure(error.localizedDescription)
            return
        }
        guard credential != nil else {
            await pairLocalHost()
            return
        }
        await bootstrap()
    }

    private func bootstrap() async {
        do {
            loadingSections.insert(.overview)
            defer { loadingSections.remove(.overview) }
            do {
                try await load(.overview, forceDriverProbe: false)
                sectionErrors[.overview] = nil
            } catch HostConsoleHTTPError.unauthorized {
                throw HostConsoleHTTPError.unauthorized
            } catch {
                sectionErrors[.overview] = error.localizedDescription
            }
            lastUpdated = Date()
            phase = .ready

            Task { [weak self] in
                await self?.loadRemainingSections()
            }
        } catch HostConsoleHTTPError.unauthorized {
            await handleUnauthorizedCredential()
        } catch {
            phase = .failure(error.localizedDescription)
        }
    }

    func refresh(forceDriverProbe: Bool) async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let manifest: HostManifest = try await request("/.well-known/aru.json")
            try manifest.validate()
            self.manifest = manifest

            guard credential != nil else {
                await pairLocalHost()
                return
            }
            try await loadAllSections(forceDriverProbe: forceDriverProbe)
            lastUpdated = Date()
            phase = .ready
        } catch HostConsoleHTTPError.unauthorized {
            await handleUnauthorizedCredential()
        } catch {
            phase = .failure(error.localizedDescription)
        }
    }

    func refresh(_ section: HostConsoleSection) async {
        loadingSections.insert(section)
        defer { loadingSections.remove(section) }
        do {
            try await load(section, forceDriverProbe: section == .collaborators)
            sectionErrors[section] = nil
            lastUpdated = Date()
        } catch HostConsoleHTTPError.unauthorized {
            await handleUnauthorizedCredential()
        } catch {
            sectionErrors[section] = error.localizedDescription
        }
    }

    func pairLocalHost() async {
        guard !isPairing else { return }
        isPairing = true
        phase = .loading
        defer { isPairing = false }
        do {
            let token = try await Task.detached {
                try LocalPairingIssuer.issueToken()
            }.value
            let body = try JSONEncoder().encode(LocalHostPairingRequest(pairingToken: token))
            let grant: PairingGrant = try await request(
                "/aru/v1/pair",
                method: "POST",
                body: body
            )
            try vault.write(grant.credentialSecret)
            credential = grant.credentialSecret
            let manifest: HostManifest = try await request("/.well-known/aru.json")
            try manifest.validate()
            self.manifest = manifest
            await bootstrap()
        } catch let error as HostCredentialError {
            phase = .credentialFailure(error.localizedDescription)
        } catch {
            phase = .failure(error.localizedDescription)
        }
    }

    func issueMobilePairingLink() async throws -> String {
        try await Task.detached {
            try LocalPairingIssuer.issueLink()
        }.value
    }

    func repairLocalConnection() async {
        await reconnectLocalCredential()
    }

    private func reconnectLocalCredential() async {
        do {
            try vault.delete()
            credential = nil
            clearAuthenticatedState()
            await pairLocalHost()
        } catch {
            phase = .credentialFailure(error.localizedDescription)
        }
    }

    private func handleUnauthorizedCredential() async {
        guard !isPairing else {
            phase = .credentialFailure(L10n.pairingExpired)
            return
        }
        await reconnectLocalCredential()
    }

    func createCollaborator(
        displayName: String,
        driverId: String,
        providerProfileId: String?
    ) async throws {
        guard !isCreatingCollaborator else { return }
        isCreatingCollaborator = true
        defer { isCreatingCollaborator = false }
        let payload = CreateHostedCollaboratorBody(
            displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines),
            driverId: driverId,
            providerProfileId: providerProfileId
        )
        let body = try JSONEncoder().encode(payload)
        let created: HostedCollaborator = try await request(
            "/aru/v1/hosted-collaborators",
            method: "POST",
            body: body,
            authenticated: true
        )
        collaborators.append(created)
        diagnostics = try? await request("/aru/v1/diagnostics", authenticated: true)
        lastUpdated = Date()
    }

    func updateCollaboratorDriver(
        for collaborator: HostedCollaborator,
        driverId: String,
        providerProfileId: String?
    ) async throws {
        guard !mutatingCollaboratorIds.contains(collaborator.id) else { return }
        mutatingCollaboratorIds.insert(collaborator.id)
        defer { mutatingCollaboratorIds.remove(collaborator.id) }
        let body = try JSONEncoder().encode(UpdateHostedCollaboratorDriverBody(
            expectedRevision: collaborator.revision,
            driverId: driverId,
            providerProfileId: providerProfileId
        ))
        let updated: HostedCollaborator = try await request(
            "/aru/v1/hosted-collaborators/\(collaborator.id)",
            method: "PUT",
            body: body,
            authenticated: true
        )
        if let index = collaborators.firstIndex(where: { $0.id == updated.id }) {
            collaborators[index] = updated
        }
        sectionErrors[.collaborators] = nil
        lastUpdated = Date()
    }

    func updateToolAccess(
        for collaborator: HostedCollaborator,
        toolAccess: HostedCollaboratorToolAccess
    ) async throws {
        guard !mutatingCollaboratorIds.contains(collaborator.id) else { return }
        mutatingCollaboratorIds.insert(collaborator.id)
        defer { mutatingCollaboratorIds.remove(collaborator.id) }

        let body = try JSONEncoder().encode(UpdateHostedCollaboratorToolAccessBody(
            expectedRevision: collaborator.revision,
            toolAccess: toolAccess
        ))
        let updated: HostedCollaborator = try await request(
            "/aru/v1/hosted-collaborators/\(collaborator.id)",
            method: "PUT",
            body: body,
            authenticated: true
        )
        if let index = collaborators.firstIndex(where: { $0.id == updated.id }) {
            collaborators[index] = updated
        }
        sectionErrors[.mcp] = nil
        sectionErrors[.collaborators] = nil
        lastUpdated = Date()
    }

    func surfaceDetail(collaboratorId: String,
                       surfaceId: String) async throws -> HostCollaboratorSurface {
        try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/surfaces/\(surfaceId)",
            authenticated: true)
    }

    @discardableResult
    func publishSurface(collaborator: HostedCollaborator,
                        surface: HostCollaboratorSurface?,
                        title: String,
                        sourceHTML: String,
                        note: String) async throws -> HostCollaboratorSurface {
        let mutationId = surface?.surfaceId ?? "new::\(collaborator.id)"
        guard !mutatingSurfaceIds.contains(mutationId) else {
            throw HostConsoleHTTPError.server(L10n.surfaceMutationInProgress)
        }
        mutatingSurfaceIds.insert(mutationId)
        defer { mutatingSurfaceIds.remove(mutationId) }
        let path: String
        let body: Data
        let method: String
        if let surface {
            path = "/aru/v1/hosted-collaborators/\(collaborator.id)/surfaces/\(surface.surfaceId)"
            method = "PUT"
            body = try JSONEncoder().encode(UpdateHostCollaboratorSurfaceBody(
                expectedRevision: surface.revision,
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                sourceHTML: sourceHTML,
                note: note.trimmingCharacters(in: .whitespacesAndNewlines)))
        } else {
            path = "/aru/v1/hosted-collaborators/\(collaborator.id)/surfaces"
            method = "POST"
            body = try JSONEncoder().encode(CreateHostCollaboratorSurfaceBody(
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                sourceHTML: sourceHTML,
                note: note.trimmingCharacters(in: .whitespacesAndNewlines)))
        }
        let updated: HostCollaboratorSurface = try await request(
            path, method: method, body: body, authenticated: true)
        try await refreshSurfaces(collaboratorId: collaborator.id)
        lastUpdated = Date()
        return updated
    }

    @discardableResult
    func rollbackSurface(collaborator: HostedCollaborator,
                         surface: HostCollaboratorSurface,
                         versionId: String) async throws -> HostCollaboratorSurface {
        guard !mutatingSurfaceIds.contains(surface.surfaceId) else {
            throw HostConsoleHTTPError.server(L10n.surfaceMutationInProgress)
        }
        mutatingSurfaceIds.insert(surface.surfaceId)
        defer { mutatingSurfaceIds.remove(surface.surfaceId) }
        let body = try JSONEncoder().encode(RollbackHostCollaboratorSurfaceBody(
            expectedRevision: surface.revision,
            versionId: versionId,
            note: L10n.surfaceRollbackNote))
        let updated: HostCollaboratorSurface = try await request(
            "/aru/v1/hosted-collaborators/\(collaborator.id)/surfaces/\(surface.surfaceId)/rollback",
            method: "POST",
            body: body,
            authenticated: true)
        try await refreshSurfaces(collaboratorId: collaborator.id)
        lastUpdated = Date()
        return updated
    }

    @discardableResult
    func setSurfaceArchived(_ archived: Bool,
                            collaborator: HostedCollaborator,
                            surface: HostCollaboratorSurface) async throws -> HostCollaboratorSurface {
        guard !mutatingSurfaceIds.contains(surface.surfaceId) else {
            throw HostConsoleHTTPError.server(L10n.surfaceMutationInProgress)
        }
        mutatingSurfaceIds.insert(surface.surfaceId)
        defer { mutatingSurfaceIds.remove(surface.surfaceId) }
        let body = try JSONEncoder().encode(ArchiveHostCollaboratorSurfaceBody(
            expectedRevision: surface.revision))
        let action = archived ? "archive" : "restore"
        let updated: HostCollaboratorSurface = try await request(
            "/aru/v1/hosted-collaborators/\(collaborator.id)/surfaces/\(surface.surfaceId)/\(action)",
            method: "POST",
            body: body,
            authenticated: true)
        try await refreshSurfaces(collaboratorId: collaborator.id)
        lastUpdated = Date()
        return updated
    }

    func refreshSurfaces(collaboratorId: String) async throws {
        let inventory: HostCollaboratorSurfaceInventory = try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/surfaces",
            authenticated: true)
        guard inventory.schema == "aru.selfhost.collaborator-surface-inventory.v1",
              inventory.collaboratorId == collaboratorId else {
            throw HostConsoleModelError.invalidCollaboratorSchema
        }
        collaboratorSurfaces[collaboratorId] = inventory.surfaces
        lastUpdated = Date()
    }

    func refreshConversations(collaboratorId: String) async throws {
        let inventory: HostCollaboratorConversationInventory = try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/conversations",
            authenticated: true)
        guard inventory.schema == "aru.selfhost.collaborator-conversation-inventory.v1",
              inventory.collaboratorId == collaboratorId else {
            throw HostConsoleModelError.invalidCollaboratorSchema
        }
        collaboratorConversations[collaboratorId] = inventory.conversations
        lastUpdated = Date()
    }

    func createConversation(collaboratorId: String) async throws -> HostCollaboratorConversation {
        let body = try JSONEncoder().encode(CreateHostCollaboratorConversationBody(title: nil))
        let created: HostCollaboratorConversation = try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/conversations",
            method: "POST",
            body: body,
            authenticated: true)
        try await refreshConversations(collaboratorId: collaboratorId)
        collaboratorConversationDetails[created.conversationId] = created
        return created
    }

    func conversationDetail(
        collaboratorId: String,
        conversationId: String
    ) async throws -> HostCollaboratorConversation {
        let detail: HostCollaboratorConversation = try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/conversations/\(conversationId)",
            authenticated: true)
        collaboratorConversationDetails[conversationId] = detail
        mergeConversationProjection(detail)
        return detail
    }

    func sendConversationMessage(
        collaboratorId: String,
        conversationId: String,
        text: String
    ) async throws -> HostCollaboratorConversation {
        guard !mutatingConversationIds.contains(conversationId) else {
            throw HostConsoleHTTPError.server(L10n.conversationMutationInProgress)
        }
        mutatingConversationIds.insert(conversationId)
        defer { mutatingConversationIds.remove(conversationId) }
        let body = try JSONEncoder().encode(SendHostCollaboratorConversationMessageBody(
            clientRequestId: "console_\(UUID().uuidString)",
            text: text.trimmingCharacters(in: .whitespacesAndNewlines)))
        let detail: HostCollaboratorConversation = try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/conversations/\(conversationId)/messages",
            method: "POST",
            body: body,
            authenticated: true)
        collaboratorConversationDetails[conversationId] = detail
        mergeConversationProjection(detail)
        return detail
    }

    func resolveConversationApproval(
        collaboratorId: String,
        conversationId: String,
        approvalId: String,
        decision: String
    ) async throws -> HostCollaboratorConversation {
        guard !mutatingConversationIds.contains(conversationId) else { return try await conversationDetail(
            collaboratorId: collaboratorId, conversationId: conversationId) }
        mutatingConversationIds.insert(conversationId)
        defer { mutatingConversationIds.remove(conversationId) }
        let body = try JSONEncoder().encode(ResolveHostCollaboratorConversationApprovalBody(
            decision: decision))
        let detail: HostCollaboratorConversation = try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/conversations/\(conversationId)/approvals/\(approvalId)",
            method: "POST",
            body: body,
            authenticated: true)
        collaboratorConversationDetails[conversationId] = detail
        mergeConversationProjection(detail)
        return detail
    }

    func cancelConversationTurn(
        collaboratorId: String,
        conversationId: String,
        turnId: String
    ) async throws -> HostCollaboratorConversation {
        guard !mutatingConversationIds.contains(conversationId) else { return try await conversationDetail(
            collaboratorId: collaboratorId, conversationId: conversationId) }
        mutatingConversationIds.insert(conversationId)
        defer { mutatingConversationIds.remove(conversationId) }
        let detail: HostCollaboratorConversation = try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/conversations/\(conversationId)/turns/\(turnId)/cancel",
            method: "POST",
            authenticated: true)
        collaboratorConversationDetails[conversationId] = detail
        mergeConversationProjection(detail)
        return detail
    }

    private func mergeConversationProjection(_ detail: HostCollaboratorConversation) {
        var items = collaboratorConversations[detail.collaboratorId] ?? []
        if let index = items.firstIndex(where: { $0.id == detail.id }) {
            items[index] = detail
        } else {
            items.append(detail)
        }
        collaboratorConversations[detail.collaboratorId] = items.sorted { $0.updatedAt > $1.updatedAt }
        lastUpdated = Date()
    }

    func updateNodeDisplayName(_ displayName: String) async throws {
        guard !isUpdatingNodeSettings, let nodeSettings else { return }
        isUpdatingNodeSettings = true
        defer { isUpdatingNodeSettings = false }
        let body = try JSONEncoder().encode(HostNodeSettingsUpdate(
            displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines),
            expectedRevision: nodeSettings.revision
        ))
        self.nodeSettings = try await request(
            "/aru/v1/node-settings",
            method: "PUT",
            body: body,
            authenticated: true
        )
        let refreshedManifest: HostManifest = try await request("/.well-known/aru.json")
        try refreshedManifest.validate()
        manifest = refreshedManifest
        diagnostics = try? await request("/aru/v1/diagnostics", authenticated: true)
        sectionErrors[.overview] = nil
        lastUpdated = Date()
    }

    func revokeDevice(_ device: HostPairedDevice) async throws {
        guard !device.isCurrent, !mutatingDeviceIds.contains(device.deviceId) else { return }
        mutatingDeviceIds.insert(device.deviceId)
        defer { mutatingDeviceIds.remove(device.deviceId) }
        let body = try JSONEncoder().encode(HostDeviceRevocationBody(deviceId: device.deviceId))
        let _: HostDeviceRevocation = try await request(
            "/aru/v1/devices/revoke",
            method: "POST",
            body: body,
            authenticated: true
        )
        try await loadNodeIdentityAndAccess()
        diagnostics = try? await request("/aru/v1/diagnostics", authenticated: true)
        sectionErrors[.overview] = nil
        lastUpdated = Date()
    }

    func updateBackupSettings(
        retentionMode: HostBackupRetentionMode,
        keepLatestCount: Int?
    ) async throws {
        guard !isUpdatingBackupSettings, let backupSettings else { return }
        isUpdatingBackupSettings = true
        defer { isUpdatingBackupSettings = false }
        let body = try JSONEncoder().encode(HostBackupSettingsUpdate(
            retentionMode: retentionMode,
            keepLatestCount: keepLatestCount,
            expectedRevision: backupSettings.revision))
        self.backupSettings = try await request(
            "/aru/v1/backups/settings",
            method: "PUT",
            body: body,
            authenticated: true)
        let inventory: BackupInventory = try await request("/aru/v1/backups", authenticated: true)
        backups = inventory.packages.sorted { $0.uploadedAt > $1.uploadedAt }
        sectionErrors[.backups] = nil
        lastUpdated = Date()
    }

    func deleteBackup(_ package: BackupPackage) async throws {
        guard !mutatingBackupIds.contains(package.id) else { return }
        mutatingBackupIds.insert(package.id)
        defer { mutatingBackupIds.remove(package.id) }
        let encoded = package.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? package.id
        let _: HostBackupDeletion = try await request(
            "/aru/v1/backups/\(encoded)",
            method: "DELETE",
            authenticated: true)
        try await load(.backups, forceDriverProbe: false)
        sectionErrors[.backups] = nil
        lastUpdated = Date()
    }

    func setPlugin(_ plugin: HostPlugin, enabled: Bool) async throws {
        guard !mutatingPluginIds.contains(plugin.id) else { return }
        mutatingPluginIds.insert(plugin.id)
        defer { mutatingPluginIds.remove(plugin.id) }
        beginPluginAction()
        let action = enabled ? "enable" : "disable"
        do {
            let updated: HostPlugin = try await request(
                "/aru/v1/plugins/\(encodedPluginID(plugin.id))/\(action)",
                method: "POST",
                authenticated: true
            )
            try await reloadPluginSurfaces()
            finishPluginAction(enabled ? L10n.pluginEnabled(updated.manifest.displayName) : L10n.pluginDisabled(updated.manifest.displayName))
        } catch {
            try? await reloadPluginSurfaces()
            throw error
        }
    }

    func validatePluginSource(_ mutation: HostPluginSourceMutation) async throws -> HostPluginValidationResult {
        beginPluginAction()
        let body = try JSONEncoder().encode(mutation)
        let result: HostPluginValidationResult = try await request(
            "/aru/v1/plugin-workshop/validate",
            method: "POST",
            body: body,
            authenticated: true
        )
        finishPluginAction(L10n.pluginValidationSucceeded(result.tools.count))
        return result
    }

    func savePluginDraft(_ mutation: HostPluginSourceMutation) async throws -> HostPluginDraft {
        guard !mutatingPluginIds.contains(mutation.pluginId) else {
            throw HostConsoleHTTPError.server(L10n.pluginOperationInProgress)
        }
        mutatingPluginIds.insert(mutation.pluginId)
        defer { mutatingPluginIds.remove(mutation.pluginId) }
        beginPluginAction()
        let body = try JSONEncoder().encode(mutation)
        let draft: HostPluginDraft = try await request(
            "/aru/v1/plugin-workshop/drafts",
            method: "POST",
            body: body,
            authenticated: true
        )
        try await loadPluginState()
        finishPluginAction(L10n.pluginDraftSaved(draft.displayName))
        return draft
    }

    func applyPluginSource(_ mutation: HostPluginSourceMutation) async throws -> HostPlugin {
        guard !mutatingPluginIds.contains(mutation.pluginId) else {
            throw HostConsoleHTTPError.server(L10n.pluginOperationInProgress)
        }
        mutatingPluginIds.insert(mutation.pluginId)
        defer { mutatingPluginIds.remove(mutation.pluginId) }
        beginPluginAction()
        let body = try JSONEncoder().encode(mutation)
        do {
            let result: HostPluginApplyResult = try await request(
                "/aru/v1/plugin-workshop/apply",
                method: "POST",
                body: body,
                authenticated: true
            )
            try await reloadPluginSurfaces()
            finishPluginAction(L10n.pluginApplied(result.plugin.manifest.displayName))
            return result.plugin
        } catch {
            try? await reloadPluginSurfaces()
            throw error
        }
    }

    func applyPluginDraft(_ draft: HostPluginDraft) async throws -> HostPlugin {
        guard !mutatingPluginIds.contains(draft.id) else {
            throw HostConsoleHTTPError.server(L10n.pluginOperationInProgress)
        }
        mutatingPluginIds.insert(draft.id)
        defer { mutatingPluginIds.remove(draft.id) }
        beginPluginAction()
        do {
            let result: HostPluginApplyResult = try await request(
                "/aru/v1/plugin-workshop/drafts/\(encodedPluginID(draft.id))/apply",
                method: "POST",
                authenticated: true
            )
            try await reloadPluginSurfaces()
            finishPluginAction(L10n.pluginApplied(result.plugin.manifest.displayName))
            return result.plugin
        } catch {
            try? await reloadPluginSurfaces()
            throw error
        }
    }

    func loadPluginDraft(_ pluginId: String) async throws -> HostPluginDraft {
        try await request(
            "/aru/v1/plugin-workshop/drafts/\(encodedPluginID(pluginId))",
            authenticated: true
        )
    }

    func loadPluginSource(_ pluginId: String) async throws -> HostPluginSource {
        try await request(
            "/aru/v1/plugins/\(encodedPluginID(pluginId))/source",
            authenticated: true
        )
    }

    func deletePluginDraft(_ draft: HostPluginDraft) async throws {
        guard !mutatingPluginIds.contains(draft.id) else { return }
        mutatingPluginIds.insert(draft.id)
        defer { mutatingPluginIds.remove(draft.id) }
        beginPluginAction()
        let _: HostPluginDraftDeletion = try await request(
            "/aru/v1/plugin-workshop/drafts/\(encodedPluginID(draft.id))",
            method: "DELETE",
            authenticated: true
        )
        try await loadPluginState()
        finishPluginAction(L10n.pluginDraftDeleted(draft.displayName))
    }

    func rollbackPlugin(_ plugin: HostPlugin) async throws {
        guard !mutatingPluginIds.contains(plugin.id) else { return }
        mutatingPluginIds.insert(plugin.id)
        defer { mutatingPluginIds.remove(plugin.id) }
        beginPluginAction()
        do {
            let restored: HostPlugin = try await request(
                "/aru/v1/plugins/\(encodedPluginID(plugin.id))/rollback",
                method: "POST",
                authenticated: true
            )
            try await reloadPluginSurfaces()
            finishPluginAction(L10n.pluginRolledBack(restored.manifest.displayName, restored.manifest.version))
        } catch {
            try? await reloadPluginSurfaces()
            throw error
        }
    }

    func uninstallPlugin(_ plugin: HostPlugin, deleteData: Bool) async throws {
        guard !mutatingPluginIds.contains(plugin.id) else { return }
        mutatingPluginIds.insert(plugin.id)
        defer { mutatingPluginIds.remove(plugin.id) }
        beginPluginAction()
        let _: HostPluginUninstallResult = try await request(
            "/aru/v1/plugins/\(encodedPluginID(plugin.id))?deleteData=\(deleteData ? "true" : "false")",
            method: "DELETE",
            authenticated: true
        )
        try await reloadPluginSurfaces()
        finishPluginAction(L10n.pluginUninstalled(plugin.manifest.displayName))
    }

    func reportPluginActionFailure(_ error: Error) {
        pluginActionFailed = true
        pluginActionMessage = error.localizedDescription
        sectionErrors[.plugins] = error.localizedDescription
    }

    func clearPluginActionMessage() {
        pluginActionMessage = nil
        pluginActionFailed = false
    }

    func updateJobPolicy(maximumRuntimeSeconds: Int64?) async throws {
        guard !isUpdatingJobPolicy else { return }
        isUpdatingJobPolicy = true
        defer { isUpdatingJobPolicy = false }
        let body = try JSONEncoder().encode(
            HostWorkspaceJobPolicyUpdate(defaultMaximumRuntimeSeconds: maximumRuntimeSeconds)
        )
        jobPolicy = try await request(
            "/aru/v1/jobs/policy",
            method: "PUT",
            body: body,
            authenticated: true
        )
        sectionErrors[.runtime] = nil
        lastUpdated = Date()
    }

    func authorizeWorkspace(_ url: URL) async throws {
        guard !isUpdatingWorkspaces else { return }
        isUpdatingWorkspaces = true
        defer { isUpdatingWorkspaces = false }
        let body = try JSONEncoder().encode(HostNodeWorkspaceGrant(
            rootPath: url.path,
            displayName: url.lastPathComponent.isEmpty ? url.path : url.lastPathComponent
        ))
        let _: HostNodeWorkspace = try await request(
            "/aru/v1/node-workspaces",
            method: "POST",
            body: body,
            authenticated: true
        )
        try await load(.workspaces, forceDriverProbe: false)
        diagnostics = try? await request("/aru/v1/diagnostics", authenticated: true)
        sectionErrors[.workspaces] = nil
        lastUpdated = Date()
    }

    func revokeWorkspace(_ workspace: HostNodeWorkspace) async throws {
        guard !isUpdatingWorkspaces else { return }
        isUpdatingWorkspaces = true
        defer { isUpdatingWorkspaces = false }
        let _: HostNodeWorkspaceRevocation = try await request(
            "/aru/v1/node-workspaces/\(workspace.workspaceId)",
            method: "DELETE",
            authenticated: true
        )
        try await load(.workspaces, forceDriverProbe: false)
        diagnostics = try? await request("/aru/v1/diagnostics", authenticated: true)
        sectionErrors[.workspaces] = nil
        lastUpdated = Date()
    }

    private func loadAllSections(forceDriverProbe: Bool) async throws {
        loadingSections = Set(HostConsoleSection.allCases)
        defer { loadingSections.removeAll() }
        for section in HostConsoleSection.allCases {
            do {
                try await load(section, forceDriverProbe: forceDriverProbe && section == .collaborators)
                sectionErrors[section] = nil
            } catch HostConsoleHTTPError.unauthorized {
                throw HostConsoleHTTPError.unauthorized
            } catch {
                sectionErrors[section] = error.localizedDescription
            }
        }
    }

    private func loadRemainingSections() async {
        let sections = HostConsoleSection.allCases.filter { $0 != .overview }
        loadingSections.formUnion(sections)
        defer { loadingSections.subtract(sections) }
        for section in sections {
            do {
                try await load(section, forceDriverProbe: false)
                sectionErrors[section] = nil
            } catch HostConsoleHTTPError.unauthorized {
                await handleUnauthorizedCredential()
                return
            } catch {
                sectionErrors[section] = error.localizedDescription
            }
        }
        lastUpdated = Date()
    }

    private func load(_ section: HostConsoleSection, forceDriverProbe: Bool) async throws {
        switch section {
        case .overview:
            diagnostics = try await request("/aru/v1/diagnostics", authenticated: true)
            try await loadNodeIdentityAndAccess()
        case .backups:
            async let inventoryRequest: BackupInventory = request("/aru/v1/backups", authenticated: true)
            async let settingsRequest: HostBackupSettings = request(
                "/aru/v1/backups/settings",
                authenticated: true)
            let (inventory, settings) = try await (inventoryRequest, settingsRequest)
            backups = inventory.packages.sorted { $0.uploadedAt > $1.uploadedAt }
            backupSettings = settings
        case .mcp:
            mcpGateway = try await loadMCPCatalog()
        case .plugins:
            try await loadPluginState()
        case .workspaces:
            let inventory: HostNodeWorkspaceInventory = try await request(
                "/aru/v1/node-workspaces",
                authenticated: true
            )
            workspaces = inventory.workspaces
        case .runtime:
            let inventory: HostWorkspaceJobInventory = try await request("/aru/v1/jobs", authenticated: true)
            let policy: HostWorkspaceJobPolicy = try await request("/aru/v1/jobs/policy", authenticated: true)
            jobs = inventory.jobs
            jobPolicy = policy
        case .artifacts:
            let inventory: HostArtifactInventory = try await request("/aru/v1/artifacts", authenticated: true)
            artifacts = inventory.artifacts
        case .collaborators:
            let driverPath = forceDriverProbe ? "/aru/v1/agent-drivers/refresh" : "/aru/v1/agent-drivers"
            let driverMethod = forceDriverProbe ? "POST" : "GET"
            let drivers: AgentDriverInventory = try await request(
                driverPath,
                method: driverMethod,
                authenticated: true
            )
            let roots: HostedCollaboratorInventory = try await request(
                "/aru/v1/hosted-collaborators",
                authenticated: true
            )
            try drivers.validate()
            try roots.validate()
            driverInventory = drivers
            collaborators = roots.collaborators
            for collaborator in roots.collaborators {
                try await refreshSurfaces(collaboratorId: collaborator.id)
                try await refreshConversations(collaboratorId: collaborator.id)
                try await refreshCognition(collaboratorId: collaborator.id)
            }
        }
    }

    private func loadNodeIdentityAndAccess() async throws {
        let settings: HostNodeSettings = try await request(
            "/aru/v1/node-settings",
            authenticated: true
        )
        let inventory: HostPairedDeviceInventory = try await request(
            "/aru/v1/devices",
            authenticated: true
        )
        nodeSettings = settings
        pairedDevices = inventory.devices.sorted {
            if $0.isCurrent != $1.isCurrent { return $0.isCurrent }
            return $0.issuedAt > $1.issuedAt
        }
    }

    private func loadMCPCatalog() async throws -> MCPGatewaySnapshot {
        let initializeBody = try JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": [
                "protocolVersion": "2025-03-26",
                "capabilities": [:],
                "clientInfo": ["name": "Aru Host Console", "version": "0.3.0"],
            ],
        ])
        let (initializeData, initializeResponse) = try await dataRequest(
            "/aru/v1/mcp",
            method: "POST",
            body: initializeBody,
            authenticated: true,
            headers: ["Accept": "application/json, text/event-stream"]
        )
        let initialized = try JSONDecoder().decode(MCPInitializeEnvelope.self, from: initializeData)
        guard let sessionId = initializeResponse.value(forHTTPHeaderField: "mcp-session-id"),
              !sessionId.isEmpty else {
            throw HostConsoleHTTPError.server(L10n.mcpSessionMissing)
        }
        let toolsBody = try JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": [:],
        ])
        let (toolsData, _) = try await dataRequest(
            "/aru/v1/mcp",
            method: "POST",
            body: toolsBody,
            authenticated: true,
            headers: [
                "Accept": "application/json, text/event-stream",
                "mcp-session-id": sessionId,
            ]
        )
        let tools = try JSONDecoder().decode(MCPToolsEnvelope.self, from: toolsData)
        return MCPGatewaySnapshot(
            serverName: initialized.result.serverInfo.name,
            serverVersion: initialized.result.serverInfo.version,
            protocolVersion: initialized.result.protocolVersion,
            tools: tools.result.tools.sorted { $0.name < $1.name }
        )
    }

    func request<Response: Decodable>(
        _ path: String,
        method: String = "GET",
        body: Data? = nil,
        authenticated: Bool = false
    ) async throws -> Response {
        let (data, _) = try await dataRequest(
            path,
            method: method,
            body: body,
            authenticated: authenticated
        )
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private func dataRequest(
        _ path: String,
        method: String,
        body: Data?,
        authenticated: Bool,
        headers: [String: String] = [:]
    ) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw HostConsoleHTTPError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if authenticated, let credential {
            request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        }
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw HostConsoleHTTPError.invalidResponse
        }
        if http.statusCode == 401 || http.statusCode == 403 {
            throw HostConsoleHTTPError.unauthorized
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = try? JSONDecoder().decode(HostAPIError.self, from: data)
            throw HostConsoleHTTPError.server(body?.message ?? body?.error ?? "HTTP \(http.statusCode)")
        }
        return (data, http)
    }

    private func clearAuthenticatedState() {
        diagnostics = nil
        nodeSettings = nil
        pairedDevices = []
        backups = []
        backupSettings = nil
        mcpGateway = nil
        plugins = []
        pluginDrafts = []
        pluginActionMessage = nil
        pluginActionFailed = false
        workspaces = []
        jobs = []
        jobPolicy = nil
        artifacts = []
        driverInventory = nil
        collaborators = []
        collaboratorSurfaces = [:]
        collaboratorConversations = [:]
        collaboratorConversationDetails = [:]
        collaboratorCognitions = [:]
        sectionErrors = [:]
        loadingSections = []
    }

    private func loadPluginState() async throws {
        async let inventoryRequest: HostPluginInventory = request("/aru/v1/plugins", authenticated: true)
        async let draftRequest: HostPluginDraftInventory = request(
            "/aru/v1/plugin-workshop/drafts",
            authenticated: true
        )
        let (inventory, drafts) = try await (inventoryRequest, draftRequest)
        plugins = inventory.plugins.sorted { $0.updatedAt > $1.updatedAt }
        pluginDrafts = drafts.drafts.sorted { $0.updatedAt > $1.updatedAt }
    }

    private func reloadPluginSurfaces() async throws {
        try await loadPluginState()
        mcpGateway = try await loadMCPCatalog()
        diagnostics = try? await request("/aru/v1/diagnostics", authenticated: true)
        sectionErrors[.plugins] = nil
        sectionErrors[.mcp] = nil
        lastUpdated = Date()
    }

    private func beginPluginAction() {
        pluginActionMessage = nil
        pluginActionFailed = false
        sectionErrors[.plugins] = nil
    }

    private func finishPluginAction(_ message: String) {
        pluginActionMessage = message
        pluginActionFailed = false
        sectionErrors[.plugins] = nil
        lastUpdated = Date()
    }

    private func encodedPluginID(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}

enum HostConsoleHTTPError: LocalizedError {
    case invalidURL
    case invalidResponse
    case unauthorized
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL: L10n.invalidURL
        case .invalidResponse: L10n.invalidResponse
        case .unauthorized: L10n.pairingExpired
        case .server(let message): message
        }
    }
}

enum LocalHostLocator {
    static func baseURL() -> URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let envURL = home.appending(path: "Library/Application Support/Aru Self-Hosted/instances/home/config/node.env")
        guard let contents = try? String(contentsOf: envURL, encoding: .utf8),
              let portLine = contents.split(separator: "\n").first(where: { $0.hasPrefix("ARU_PORT=") }),
              let port = Int(portLine.dropFirst("ARU_PORT=".count)),
              let url = URL(string: "http://127.0.0.1:\(port)") else {
            return URL(string: "http://127.0.0.1:8787")!
        }
        return url
    }
}

enum LocalPairingIssuer {
    static func issueLink() throws -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let executable = home.appending(path: ".local/bin/aru-selfhost")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw LocalPairingError.controlToolMissing
        }
        let process = Process()
        let output = Pipe()
        let error = Pipe()
        process.executableURL = executable
        process.arguments = ["--instance", "home", "pairing"]
        process.standardOutput = output
        process.standardError = error
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw LocalPairingError.commandFailed
        }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        guard let text = String(data: data, encoding: .utf8),
              let link = pairingLink(from: text) else {
            throw LocalPairingError.invalidPairingLink
        }
        return link
    }

    static func issueToken() throws -> String {
        guard let components = URLComponents(string: try issueLink()),
              let token = components.queryItems?.first(where: { $0.name == "pairingToken" })?.value,
              !token.isEmpty else {
            throw LocalPairingError.invalidPairingLink
        }
        return token
    }

    static func pairingLink(from output: String) -> String? {
        for line in output.split(whereSeparator: \.isNewline) {
            let candidate = String(line).trimmingCharacters(in: .whitespacesAndNewlines)
            guard candidate.hasPrefix("aru://pair?"),
                  let components = URLComponents(string: candidate) else { continue }
            let query = (components.queryItems ?? []).reduce(into: [String: String]()) { values, item in
                guard values[item.name] == nil, let value = item.value else { return }
                values[item.name] = value
            }
            guard query["canonicalUrl"]?.isEmpty == false,
                  query["serverId"]?.isEmpty == false,
                  query["pairingToken"]?.isEmpty == false else { continue }
            return candidate
        }
        return nil
    }
}

enum LocalPairingError: LocalizedError {
    case controlToolMissing
    case commandFailed
    case invalidPairingLink

    var errorDescription: String? {
        switch self {
        case .controlToolMissing: L10n.controlToolMissing
        case .commandFailed: L10n.pairingCommandFailed
        case .invalidPairingLink: L10n.invalidPairingLink
        }
    }
}

import Foundation
import Observation

@MainActor
@Observable
final class HostConsoleRuntime {
    private(set) var phase: HostConsolePhase = .loading
    private(set) var manifest: HostManifest?
    private(set) var diagnostics: HostDiagnostics?
    private(set) var nodeSettings: HostNodeSettings?
    private(set) var pairedDevices: [HostPairedDevice] = []
    private(set) var backups: [BackupPackage] = []
    private(set) var backupSettings: HostBackupSettings?
    private(set) var mcpGateway: MCPGatewaySnapshot?
    private(set) var plugins: [HostPlugin] = []
    private(set) var pluginDrafts: [HostPluginDraft] = []
    private(set) var pluginActionMessage: String?
    private(set) var pluginActionFailed = false
    private(set) var workspaces: [HostNodeWorkspace] = []
    private(set) var jobs: [HostWorkspaceJob] = []
    private(set) var jobPolicy: HostWorkspaceJobPolicy?
    private(set) var artifacts: [HostArtifact] = []
    private(set) var driverInventory: AgentDriverInventory?
    private(set) var collaborators: [HostedCollaborator] = []
    var collaboratorProjects: [String: [HostCollaboratorProject]] = [:]
    var collaboratorCognitions: [String: HostCollaboratorCognition] = [:]
    var collaboratorInitiatives: [String: HostCollaboratorInitiative] = [:]
    private(set) var sectionErrors: [HostConsoleSection: String] = [:]
    private(set) var loadingSections: Set<HostConsoleSection> = []
    private(set) var mutatingPluginIds: Set<String> = []
    private(set) var isRefreshing = false
    private(set) var isPairing = false
    private(set) var isCreatingCollaborator = false
    private(set) var mutatingCollaboratorIds: Set<String> = []
    var mutatingProjectIds: Set<String> = []
    var mutatingCognitionIds: Set<String> = []
    var mutatingInitiativeIds: Set<String> = []
    private(set) var isUpdatingJobPolicy = false
    private(set) var isUpdatingWorkspaces = false
    private(set) var isUpdatingNodeSettings = false
    private(set) var mutatingDeviceIds: Set<String> = []
    private(set) var mutatingBackupIds: Set<String> = []
    private(set) var isUpdatingBackupSettings = false
    private(set) var lastUpdated: Date?

    @ObservationIgnored lazy var conversations = HostConsoleConversations(
        load: { [weak self] path, method, body in
            guard let self else { throw CancellationError() }
            return try await self.dataRequest(path, method: method, body: body, authenticated: true).0
        },
        didUpdate: { [weak self] in self?.lastUpdated = Date() })

    @ObservationIgnored lazy var surfaces = HostConsoleSurfaces(
        load: { [weak self] path, method, body in
            guard let self else { throw CancellationError() }
            return try await self.dataRequest(path, method: method, body: body, authenticated: true).0
        }, didUpdate: { [weak self] in self?.lastUpdated = Date() })

    private let session: URLSession
    private let vault: HostCredentialVault
    private let configuredBaseURL: URL?
    private let hostCoreInstaller: any HostCoreInstalling
    private var credential: String?
    @ObservationIgnored private var refreshingSections: Set<HostConsoleSection> = []

    init(
        session: URLSession = .shared,
        vault: HostCredentialVault = HostCredentialVault(),
        baseURL: URL? = nil,
        hostCoreInstaller: any HostCoreInstalling = BundledHostCoreInstaller()
    ) {
        self.session = session
        self.vault = vault
        self.configuredBaseURL = baseURL
        self.hostCoreInstaller = hostCoreInstaller
    }

    var managesLocalHost: Bool { configuredBaseURL == nil }

    private var baseURL: URL { configuredBaseURL ?? LocalHostLocator.baseURL() }

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
        phase = .preparingHost
        do {
            try await hostCoreInstaller.prepare()
        } catch {
            phase = .failure(error.localizedDescription)
            return
        }
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

    func refresh(
        _ section: HostConsoleSection,
        forceDriverProbe: Bool = false,
        showsActivity: Bool = true
    ) async {
        guard !refreshingSections.contains(section) else { return }
        refreshingSections.insert(section)
        if showsActivity { loadingSections.insert(section) }
        defer {
            refreshingSections.remove(section)
            if showsActivity { loadingSections.remove(section) }
        }
        do {
            try await load(section, forceDriverProbe: forceDriverProbe && section == .collaborators)
            setSectionError(nil, for: section)
            lastUpdated = Date()
        } catch HostConsoleHTTPError.unauthorized {
            await handleUnauthorizedCredential()
        } catch {
            setSectionError(error.localizedDescription, for: section)
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
            async let diagnosticsRequest: HostDiagnostics = request(
                "/aru/v1/diagnostics",
                authenticated: true
            )
            async let settingsRequest: HostNodeSettings = request(
                "/aru/v1/node-settings",
                authenticated: true
            )
            async let devicesRequest: HostPairedDeviceInventory = request(
                "/aru/v1/devices",
                authenticated: true
            )
            let (nextDiagnostics, nextSettings, inventory) = try await (
                diagnosticsRequest,
                settingsRequest,
                devicesRequest
            )
            let nextDevices = Self.sortedDevices(inventory.devices)
            assignIfChanged(nextDiagnostics, to: \HostConsoleRuntime.diagnostics)
            assignIfChanged(nextSettings, to: \HostConsoleRuntime.nodeSettings)
            assignIfChanged(nextDevices, to: \HostConsoleRuntime.pairedDevices)
        case .backups:
            async let inventoryRequest: BackupInventory = request("/aru/v1/backups", authenticated: true)
            async let settingsRequest: HostBackupSettings = request(
                "/aru/v1/backups/settings",
                authenticated: true)
            let (inventory, settings) = try await (inventoryRequest, settingsRequest)
            assignIfChanged(
                inventory.packages.sorted { $0.uploadedAt > $1.uploadedAt },
                to: \HostConsoleRuntime.backups
            )
            assignIfChanged(settings, to: \HostConsoleRuntime.backupSettings)
        case .mcp:
            assignIfChanged(try await loadMCPCatalog(), to: \HostConsoleRuntime.mcpGateway)
        case .plugins:
            try await loadPluginState()
        case .workspaces:
            let inventory: HostNodeWorkspaceInventory = try await request(
                "/aru/v1/node-workspaces",
                authenticated: true
            )
            assignIfChanged(inventory.workspaces, to: \HostConsoleRuntime.workspaces)
        case .runtime:
            let inventory: HostWorkspaceJobInventory = try await request("/aru/v1/jobs", authenticated: true)
            let policy: HostWorkspaceJobPolicy = try await request("/aru/v1/jobs/policy", authenticated: true)
            assignIfChanged(inventory.jobs, to: \HostConsoleRuntime.jobs)
            assignIfChanged(policy, to: \HostConsoleRuntime.jobPolicy)
        case .artifacts:
            let inventory: HostArtifactInventory = try await request("/aru/v1/artifacts", authenticated: true)
            assignIfChanged(inventory.artifacts, to: \HostConsoleRuntime.artifacts)
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
            assignIfChanged(drivers, to: \HostConsoleRuntime.driverInventory)
            assignIfChanged(roots.collaborators, to: \HostConsoleRuntime.collaborators)
            for collaborator in roots.collaborators {
                try await surfaces.refreshSurfaces(collaboratorId: collaborator.id)
                try await conversations.refreshConversations(collaboratorId: collaborator.id)
                try await refreshCognition(collaboratorId: collaborator.id)
            }
        }
    }

    private func loadNodeIdentityAndAccess() async throws {
        async let settingsRequest: HostNodeSettings = request(
            "/aru/v1/node-settings",
            authenticated: true
        )
        async let devicesRequest: HostPairedDeviceInventory = request(
            "/aru/v1/devices",
            authenticated: true
        )
        let (settings, inventory) = try await (settingsRequest, devicesRequest)
        assignIfChanged(settings, to: \HostConsoleRuntime.nodeSettings)
        assignIfChanged(Self.sortedDevices(inventory.devices), to: \HostConsoleRuntime.pairedDevices)
    }

    private static func sortedDevices(_ devices: [HostPairedDevice]) -> [HostPairedDevice] {
        devices.sorted {
            if $0.isCurrent != $1.isCurrent { return $0.isCurrent }
            return $0.issuedAt > $1.issuedAt
        }
    }

    private func assignIfChanged<Value: Equatable>(
        _ value: Value,
        to keyPath: ReferenceWritableKeyPath<HostConsoleRuntime, Value>
    ) {
        guard self[keyPath: keyPath] != value else { return }
        self[keyPath: keyPath] = value
    }

    private func setSectionError(_ message: String?, for section: HostConsoleSection) {
        guard sectionErrors[section] != message else { return }
        sectionErrors[section] = message
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
        surfaces.clear()
        conversations.clear()
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
        assignIfChanged(
            inventory.plugins.sorted { $0.updatedAt > $1.updatedAt },
            to: \HostConsoleRuntime.plugins
        )
        assignIfChanged(
            drafts.drafts.sorted { $0.updatedAt > $1.updatedAt },
            to: \HostConsoleRuntime.pluginDrafts
        )
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

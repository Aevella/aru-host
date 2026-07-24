import Foundation

enum L10n {
    private static let localizationBundle: Bundle = {
        if let resourceURL = Bundle.main.resourceURL?
            .appending(path: "AruHostConsole_AruHostConsole.bundle"),
           let bundle = Bundle(url: resourceURL) {
            return bundle
        }
        return .module
    }()

    private static func value(_ key: String) -> String {
        String(localized: String.LocalizationValue(key), bundle: localizationBundle)
    }

    static let appName = value("app.name")
    static let appSubtitle = value("app.subtitle")
    static let refresh = value("refresh")
    static let refreshAll = value("refresh.all")
    static let checkForUpdates = value("update.check")
    static let updateReleaseUnavailable = value("error.update.release.unavailable")
    static let updateAssetMissing = value("error.update.asset.missing")
    static let overview = value("overview")
    static let backupVault = value("backup.vault")
    static let mcpGateway = value("mcp.gateway")
    static let plugins = value("plugins")
    static let computerFolders = value("computer.folders")
    static let computerFoldersSubtitle = value("computer.folders.subtitle")
    static let authorizedFolders = value("authorized.folders")
    static let addFolder = value("add.folder")
    static let defaultWorkspace = value("default.workspace")
    static let openInFinder = value("open.in.finder")
    static let noAuthorizedFolders = value("no.authorized.folders")
    static let noAuthorizedFoldersDetail = value("no.authorized.folders.detail")
    static let folderAuthorityDescription = value("folder.authority.description")
    static let revoke = value("revoke")
    static let revokeFolderTitle = value("revoke.folder.title")
    static let revokeFolderMessage = value("revoke.folder.message")
    static let runtime = value("runtime")
    static let artifacts = value("artifacts")
    static let hostCoreRunning = value("host.core.running")
    static let overviewSubtitle = value("overview.subtitle")
    static let hostCore = value("host.core")
    static let running = value("running")
    static let hostCoreDescription = value("host.core.description")
    static let encryptedPackages = value("encrypted.packages")
    static let mcpTools = value("mcp.tools")
    static let authenticatedGateway = value("authenticated.gateway")
    static let runningJobs = value("running.jobs")
    static let durableJobs = value("durable.jobs")
    static let pairedDevices = value("paired.devices")
    static let authorizedDevices = value("authorized.devices")
    static let pairedDevicesDescription = value("paired.devices.description")
    static let connectPhone = value("pairing.phone.connect")
    static let scanPairingDescription = value("pairing.phone.description")
    static let pairingCodeExpires = value("pairing.code.expires")
    static let pairingCodeExpired = value("pairing.code.expired")
    static let refreshPairingCode = value("pairing.code.refresh")
    static let copyPairingLink = value("pairing.link.copy")
    static let copied = value("copied")
    static let guideEntranceTitle = value("guide.entrance.title")
    static let guideEntranceDetail = value("guide.entrance.detail")
    static let openGuide = value("guide.open")
    static let guideTitle = value("guide.title")
    static let guideSubtitle = value("guide.subtitle")
    static let guideWelcomeTitle = value("guide.welcome.title")
    static let guideWelcomeDetail = value("guide.welcome.detail")
    static let guideStepHostTitle = value("guide.step.host.title")
    static let guideStepHostDetail = value("guide.step.host.detail")
    static let guideStepPhoneTitle = value("guide.step.phone.title")
    static let guideStepPhoneDetail = value("guide.step.phone.detail")
    static let guideStepCollaboratorTitle = value("guide.step.collaborator.title")
    static let guideStepCollaboratorDetail = value("guide.step.collaborator.detail")
    static let guideStepConversationTitle = value("guide.step.conversation.title")
    static let guideStepConversationDetail = value("guide.step.conversation.detail")
    static let showPairingCode = value("guide.pairing.show")
    static let openCollaborators = value("guide.collaborators.open")
    static let guideHostReady = value("guide.status.host.ready")
    static let guideHostNeedsAttention = value("guide.status.host.attention")
    static let guideNoPairedPhone = value("guide.status.phone.empty")
    static let guideNoCollaborator = value("guide.status.collaborator.empty")
    static let guideNoConversation = value("guide.status.conversation.empty")
    static let guideApprovalTitle = value("guide.approval.title")
    static let guideApprovalDetail = value("guide.approval.detail")
    static let guideAllowOnceDetail = value("guide.approval.once.detail")
    static let guideAllowSessionDetail = value("guide.approval.session.detail")
    static let guideDenyDetail = value("guide.approval.deny.detail")
    static let guideRecoveryTitle = value("guide.recovery.title")
    static let guideRecoveryDetail = value("guide.recovery.detail")
    static let guideRecoveryItems = [
        value("guide.recovery.mac"),
        value("guide.recovery.host"),
        value("guide.recovery.network"),
        value("guide.recovery.vpn"),
        value("guide.recovery.codex"),
        value("guide.recovery.refresh")
    ]
    static let close = value("close")
    static let retry = value("retry")
    static let noPairedDevices = value("no.paired.devices")
    static let noPairedDevicesDetail = value("no.paired.devices.detail")
    static let thisConsole = value("this.console")
    static let revokeDeviceTitle = value("revoke.device.title")
    static let revokeDeviceMessage = value("revoke.device.message")
    static let nodeIdentity = value("node.identity")
    static let nodeIdentityDescription = value("node.identity.description")
    static let rename = value("rename")
    static let renameNode = value("rename.node")
    static let renameNodeDescription = value("rename.node.description")
    static let nodeName = value("node.name")
    static let installedCapabilities = value("installed.capabilities")
    static let available = value("available")
    static let pluginSupervisor = value("plugin.supervisor")
    static let workspaceRuntime = value("workspace.runtime")
    static let jobRuntime = value("job.runtime")
    static let artifactVault = value("artifact.vault")
    static let collaboratorHost = value("collaborator.host")
    static let syncLedger = value("sync.ledger")
    static let containerRuntimeMissing = value("container.runtime.missing")
    static let reserved = value("reserved")
    static let disabled = value("disabled")
    static let backupSubtitle = value("backup.subtitle")
    static let totalStorage = value("total.storage")
    static let latestBackup = value("latest.backup")
    static let clientEncrypted = value("client.encrypted")
    static let remoteCiphertext = value("remote.ciphertext")
    static let noBackups = value("no.backups")
    static let noBackupsDetail = value("no.backups.detail")
    static let backupOrganization = value("backup.organization")
    static let backupOrganizationDescription = value("backup.organization.description")
    static let keepEveryBackup = value("backup.keep.every")
    static let keepLatestBackupsFormat = value("backup.keep.latest")
    static let backupSettingsShared = value("backup.settings.shared")
    static let backupSettingsLastAppliedFormat = value("backup.settings.last.applied")
    static let backupSettingsSaving = value("backup.settings.saving")
    static let deleteBackup = value("backup.delete")
    static let deleteBackupTitle = value("backup.delete.title")
    static let deleteBackupMessage = value("backup.delete.message")
    static let mcpSubtitle = value("mcp.subtitle")
    static let mcpAuthenticatedDescription = value("mcp.authenticated.description")
    static let toolDirectory = value("tool.directory")
    static let mcpSessionMissing = value("error.mcp.session.missing")
    static let pluginsSubtitle = value("plugins.subtitle")
    static let pluginSupervisorDescription = value("plugin.supervisor.description")
    static let noPlugins = value("no.plugins")
    static let noPluginsDetail = value("no.plugins.detail")
    static let disable = value("disable")
    static let enable = value("enable")
    static let newPlugin = value("plugin.new")
    static let pluginDrafts = value("plugin.drafts")
    static let optionalCheckpoints = value("plugin.drafts.optional")
    static let installedPlugins = value("plugin.installed")
    static let activePlugins = value("plugin.active")
    static let exposedTools = value("plugin.exposed.tools")
    static let attentionPlugins = value("plugin.attention")
    static let edit = value("edit")
    static let editSource = value("plugin.edit.source")
    static let applyNow = value("plugin.apply.now")
    static let deleteDraft = value("plugin.delete.draft")
    static let rollback = value("plugin.rollback")
    static let uninstall = value("plugin.uninstall")
    static let keepData = value("plugin.keep.data")
    static let deleteData = value("plugin.delete.data")
    static let permissions = value("plugin.permissions")
    static let zeroAuthority = value("plugin.zero.authority")
    static let networkOutbound = value("plugin.network.outbound")
    static let persistentStorage = value("plugin.persistent.storage")
    static let pluginTools = value("plugin.tools")
    static let pluginCollaborators = value("plugin.collaborators")
    static let noPluginCollaborators = value("plugin.collaborators.empty")
    static let pluginAccessAll = value("plugin.access.all")
    static let pluginAccessPartial = value("plugin.access.partial")
    static let pluginAccessNone = value("plugin.access.none")
    static let lifecycleActivity = value("plugin.activity")
    static let noLifecycleActivity = value("plugin.activity.empty")
    static let noPluginTools = value("plugin.tools.empty")
    static let lastError = value("plugin.last.error")
    static let installed = value("installed")
    static let updated = value("updated")
    static let pluginRunning = value("plugin.running")
    static let pluginDisabled = value("plugin.disabled")
    static let pluginUnhealthy = value("plugin.unhealthy")
    static let pluginDraftCreate = value("plugin.draft.create")
    static let pluginDraftUpdate = value("plugin.draft.update")
    static let pluginEditorNew = value("plugin.editor.new")
    static let pluginEditorEdit = value("plugin.editor.edit")
    static let pluginEditorDescription = value("plugin.editor.description")
    static let pluginID = value("plugin.id")
    static let pluginDisplayName = value("plugin.display.name")
    static let pluginVersion = value("plugin.version")
    static let pluginSourceCode = value("plugin.source.code")
    static let pluginSourceDescription = value("plugin.source.description")
    static let pluginCapabilityGrants = value("plugin.capability.grants")
    static let pluginValidate = value("plugin.validate")
    static let pluginSaveDraft = value("plugin.save.draft")
    static let pluginApply = value("plugin.apply")
    static let pluginDigest = value("plugin.digest")
    static let pluginOperationInProgress = value("plugin.operation.in.progress")
    static let pluginRollbackTitle = value("plugin.rollback.title")
    static let pluginUninstallTitle = value("plugin.uninstall.title")
    static let pluginDeleteDraftTitle = value("plugin.delete.draft.title")
    static let searchTools = value("mcp.search.tools")
    static let allTools = value("mcp.tools.all")
    static let hostTools = value("mcp.tools.host")
    static let pluginProvidedTools = value("mcp.tools.plugin")
    static let officialHost = value("mcp.source.host")
    static let toolInputContract = value("mcp.tool.input")
    static let readOnly = value("mcp.annotation.readonly")
    static let destructive = value("mcp.annotation.destructive")
    static let idempotent = value("mcp.annotation.idempotent")
    static let openWorld = value("mcp.annotation.openworld")
    static let noMatchingTools = value("mcp.tools.no.match")
    static let collaboratorClassification = value("mcp.collaborator.classification")
    static let customToolAccess = value("mcp.access.custom")
    static let viewByCollaborator = value("mcp.view.by.collaborator")
    static let wholeHost = value("mcp.whole.host")
    static let accessAllShort = value("mcp.access.all.short")
    static let noCollaboratorClassification = value("mcp.collaborator.none")
    static let editToolAccess = value("mcp.access.edit")
    static let noToolsForCollaborator = value("mcp.collaborator.tools.empty")
    static let noToolsForCollaboratorDetail = value("mcp.collaborator.tools.empty.detail")
    static let toolAccessExplanation = value("mcp.access.explanation")
    static let automaticAllTools = value("mcp.access.automatic")
    static let automaticAllToolsDetail = value("mcp.access.automatic.detail")
    static let chooseTools = value("mcp.access.selected")
    static let saveToolAccess = value("mcp.access.save")
    static let runtimeSubtitle = value("runtime.subtitle")
    static let noJobs = value("no.jobs")
    static let noJobsDetail = value("no.jobs.detail")
    static let noContainerRuntimeDetail = value("no.container.runtime.detail")
    static let jobLedger = value("job.ledger")
    static let runtimeReadyDescription = value("runtime.ready.description")
    static let containerRuntimeMissingDescription = value("container.runtime.missing.description")
    static let defaultJobBudget = value("default.job.budget")
    static let jobBudgetDescription = value("job.budget.description")
    static let change = value("change")
    static let unlimited = value("unlimited")
    static let jobPolicySheetDescription = value("job.policy.sheet.description")
    static let maximumHours = value("maximum.hours")
    static let saveSettings = value("save.settings")
    static let artifactsSubtitle = value("artifacts.subtitle")
    static let remoteArtifacts = value("remote.artifacts")
    static let verifiedBySHA = value("verified.by.sha")
    static let returnToPhone = value("return.to.phone")
    static let noArtifacts = value("no.artifacts")
    static let noArtifactsDetail = value("no.artifacts.detail")
    static let collaboratorsSubtitle = value("collaborators.subtitle")
    static let findingHost = value("finding.host")
    static let preparingHostCore = value("host.core.preparing")
    static let preparingHostCoreDetail = value("host.core.preparing.detail")
    static let hostCorePayloadMissing = value("error.host.core.payload.missing")
    static let hostCoreReleaseInvalid = value("error.host.core.release.invalid")
    static let hostCoreInstallerMissing = value("error.host.core.installer.missing")
    static let hostCoreInstallFailed = value("error.host.core.install.failed")
    static let thisMac = value("this.mac")
    static let pairingExplanation = value("pairing.explanation")
    static let pairing = value("pairing")
    static let connectThisMac = value("connect.this.mac")
    static let hostUnavailable = value("host.unavailable")
    static let secureConnectionUnavailable = value("secure.connection.unavailable")
    static let repairConnection = value("repair.connection")
    static let tryAgain = value("try.again")
    static let hostAuthorityDescription = value("host.authority.description")
    static let node = value("node")
    static let online = value("online")
    static let drivers = value("drivers")
    static let collaborators = value("collaborators")
    static let agentDrivers = value("agent.drivers")
    static let executionReady = value("execution.ready")
    static let executionPending = value("execution.pending")
    static let providerProfiles = value("provider.profiles")
    static let providerProfilesSubtitle = value("provider.profiles.subtitle")
    static let addProviderProfile = value("provider.profile.add")
    static let editProviderProfile = value("provider.profile.edit")
    static let noProviderProfiles = value("provider.profiles.empty")
    static let noProviderProfilesShort = value("provider.profiles.empty.short")
    static let noProviderProfilesDetail = value("provider.profiles.empty.detail")
    static let loadingProviderProfiles = value("provider.profiles.loading")
    static let providerKeychainUnavailable = value("provider.keychain.unavailable")
    static let providerKeychainUnavailableDetail = value("provider.keychain.unavailable.detail")
    static let providerEditorSubtitle = value("provider.editor.subtitle")
    static let providerProtocol = value("provider.protocol")
    static let providerName = value("provider.name")
    static let providerBaseURL = value("provider.base.url")
    static let providerPath = value("provider.path")
    static let providerModel = value("provider.model")
    static let providerMaxOutputTokens = value("provider.max.output.tokens")
    static let providerMaxOutputTokensDetail = value("provider.max.output.tokens.detail")
    static let providerMaxToolRounds = value("provider.max.tool.rounds")
    static let providerMaxToolRoundsDetail = value("provider.max.tool.rounds.detail")
    static let providerAPIKey = value("provider.api.key")
    static let providerAPIKeyRequired = value("provider.api.key.required")
    static let providerAPIKeyKeep = value("provider.api.key.keep")
    static let providerAuthMode = value("provider.auth.mode")
    static let providerNoAuth = value("provider.auth.none")
    static let providerKeychainDetail = value("provider.keychain.detail")
    static let saveAndTest = value("provider.save.test")
    static let testConnection = value("provider.test")
    static let providerConnectionFailed = value("provider.connection.failed")
    static let providerMutationInProgress = value("provider.mutation.in.progress")
    static let providerDriverNeedsProfile = value("provider.driver.needs.profile")
    static let deleteProviderProfile = value("provider.delete")
    static let deleteProviderProfileTitle = value("provider.delete.title")
    static let deleteProviderProfileDetail = value("provider.delete.detail")
    static let providerProfile = value("provider.profile")
    static let editCollaboratorDriver = value("collaborator.driver.edit")

    static func providerToolRoundsSummary(_ maximum: Int?) -> String {
        guard let maximum else { return value("provider.max.tool.rounds.unlimited") }
        return String(format: value("provider.max.tool.rounds.format"), Int64(maximum))
    }
    static let computerCollaborators = value("computer.collaborators")
    static let readOnlyProjection = value("read.only.projection")
    static let newCollaborator = value("new.collaborator")
    static let noCollaborators = value("no.collaborators")
    static let noCollaboratorsDetail = value("no.collaborators.detail")
    static let commandNotFound = value("command.not.found")
    static let driverNeedsAttention = value("driver.needs.attention")
    static let ready = value("ready")
    static let notInstalled = value("not.installed")
    static let notConfigured = value("not.configured")
    static let needsAttention = value("needs.attention")
    static let canReply = value("can.reply")
    static let executionPendingShort = value("execution.pending.short")
    static let newComputerCollaborator = value("new.computer.collaborator")
    static let newCollaboratorExplanation = value("new.collaborator.explanation")
    static let collaboratorName = value("collaborator.name")
    static let agentDriver = value("agent.driver")
    static let executionFoundationPending = value("execution.foundation.pending")
    static let collaboratorStudio = value("collaborator.studio")
    static let conversations = value("conversations")
    static let hostConversationAuthority = value("host.conversation.authority")
    static let noComputerConversations = value("computer.conversations.empty")
    static let noComputerConversationsDetail = value("computer.conversations.empty.detail")
    static let selectComputerConversation = value("computer.conversation.select")
    static let selectComputerConversationDetail = value("computer.conversation.select.detail")
    static let stopTurn = value("turn.stop")
    static let turnFailed = value("turn.failed")
    static let turnInterrupted = value("turn.interrupted")
    static let waitingForApproval = value("turn.waiting.approval")
    static let turnStarting = value("turn.starting")
    static let turnReplying = value("turn.replying")
    static let toolRunning = value("turn.tool.running")
    static let messageComputerCollaborator = value("computer.conversation.message")
    static let allowOnce = value("approval.allow.once")
    static let allowForSession = value("approval.allow.session")
    static let deny = value("approval.deny")
    static let you = value("you")
    static let loading = value("loading")
    static let conversationMutationInProgress = value("conversation.mutation.in.progress")
    static let surfaces = value("surfaces")
    static let surfaceStudioSubtitle = value("surface.studio.subtitle")
    static let conversationStudioSubtitle = value("conversation.studio.subtitle")
    static let initiative = value("initiative")
    static let initiativeStudioSubtitle = value("initiative.studio.subtitle")
    static let initiativeNew = value("initiative.new")
    static let initiativeTitle = value("initiative.title")
    static let initiativeGoal = value("initiative.goal")
    static let initiativeInstructions = value("initiative.instructions")
    static let initiativeWhen = value("initiative.when")
    static let initiativeRepeat = value("initiative.repeat")
    static let initiativeOnce = value("initiative.once")
    static let initiativeHourly = value("initiative.hourly")
    static let initiativeDaily = value("initiative.daily")
    static let initiativeWeekly = value("initiative.weekly")
    static let initiativeNotify = value("initiative.notify")
    static let initiativeNotifyShort = value("initiative.notify.short")
    static let initiativeCreate = value("initiative.create")
    static let initiativePlans = value("initiative.plans")
    static let initiativeOwnedByHost = value("initiative.host.owned")
    static let initiativeEmpty = value("initiative.empty")
    static let initiativeEmptyDetail = value("initiative.empty.detail")
    static let initiativePause = value("initiative.pause")
    static let initiativeResume = value("initiative.resume")
    static let initiativeRunNow = value("initiative.run.now")
    static let initiativeRunning = value("initiative.running")
    static let initiativePaused = value("initiative.paused")
    static let initiativeReady = value("initiative.ready")
    static let initiativeMutationInProgress = value("initiative.mutation.in.progress")
    static let projects = value("projects")
    static let projectStudioSubtitle = value("project.studio.subtitle")
    static let projectNew = value("project.new")
    static let projectNewDetail = value("project.new.detail")
    static let projectTitle = value("project.title")
    static let projectGitHub = value("project.github")
    static let projectEntry = value("project.entry")
    static let projectCreate = value("project.create")
    static let projectOwnedByHost = value("project.host.owned")
    static let projectEmpty = value("project.empty")
    static let projectEmptyDetail = value("project.empty.detail")
    static let projectDirty = value("project.dirty")
    static let projectPublished = value("project.published")
    static let projectUnpublished = value("project.unpublished")
    static let projectNote = value("project.note")
    static let projectNetwork = value("project.network")
    static let projectSave = value("project.save")
    static let projectPublish = value("project.publish")
    static let projectCreated = value("project.created")
    static let projectSaved = value("project.saved")
    static let projectPublishedNow = value("project.published.now")
    static let projectMutationInProgress = value("project.mutation.in.progress")
    static func projectCheckpoints(_ count: Int) -> String {
        String(format: value("project.checkpoints.format"), Int64(count))
    }
    static let cognition = value("cognition")
    static let cognitionStudioSubtitle = value("cognition.studio.subtitle")
    static let cognitionEnvironment = value("cognition.environment")
    static let cognitionIsolated = value("cognition.environment.isolated")
    static let cognitionIsolatedDetail = value("cognition.environment.isolated.detail")
    static let cognitionInheritCodex = value("cognition.environment.codex")
    static let cognitionInheritCodexDetail = value("cognition.environment.codex.detail")
    static let cognitionSystemPrompt = value("cognition.system.prompt")
    static let cognitionSystemPromptDetail = value("cognition.system.prompt.detail")
    static let cognitionSaved = value("cognition.saved")
    static let cognitionMemories = value("cognition.memories")
    static let cognitionReferences = value("cognition.references")
    static let cognitionMemoriesEmpty = value("cognition.memories.empty")
    static let cognitionReferencesEmpty = value("cognition.references.empty")
    static let cognitionMemoryEditor = value("cognition.memory.editor")
    static let cognitionReferenceEditor = value("cognition.reference.editor")
    static let cognitionRecordTitle = value("cognition.record.title")
    static let cognitionMutationInProgress = value("cognition.mutation.in.progress")
    static let noSurfaces = value("surface.empty")
    static let noSurfacesDetail = value("surface.empty.detail")
    static let surfaceAuthorityDescription = value("surface.authority.description")
    static let surfaceSource = value("surface.source")
    static let surfacePreview = value("surface.preview")
    static let surfaceVersions = value("surface.versions")
    static let surfaceState = value("surface.state")
    static let surfaceTitle = value("surface.title")
    static let surfaceEditor = value("surface.editor")
    static let surfaceVersionNote = value("surface.version.note")
    static let publishSurface = value("surface.publish")
    static let publishVersion = value("surface.publish.version")
    static let archive = value("archive")
    static let restore = value("restore")
    static let surfaceRollbackAction = value("rollback")
    static let current = value("current")
    static let surfacePublished = value("surface.published")
    static let surfaceRolledBack = value("surface.rolled.back")
    static let surfaceArchived = value("surface.archived")
    static let surfaceRestored = value("surface.restored")
    static let surfaceMutationInProgress = value("surface.mutation.in.progress")
    static let surfaceRollbackNote = value("surface.rollback.note")
    static let surfaceProject = value("surface.project")
    static let surfaceProjectDetail = value("surface.project.detail")
    static let surfaceProjectEntry = value("surface.project.entry")
    static let surfaceProjectFiles = value("surface.project.files")
    static let surfaceProjectBytes = value("surface.project.bytes")
    static let surfacePersistentStorage = value("surface.runtime.storage")
    static let surfacePersistentStorageDetail = value("surface.runtime.storage.detail")
    static let surfaceNetworkAccess = value("surface.runtime.network")
    static let surfaceNetworkAccessDetail = value("surface.runtime.network.detail")
    static let surfaceRuntimeSaved = value("surface.runtime.saved")
    static let cancel = value("cancel")
    static let save = value("save")
    static let create = value("create")
    static let invalidManifest = value("error.invalid.manifest")
    static let invalidDrivers = value("error.invalid.drivers")
    static let invalidCollaborators = value("error.invalid.collaborators")
    static let keychainReadFailed = value("error.keychain.read")
    static let keychainWriteFailed = value("error.keychain.write")
    static let keychainDeleteFailed = value("error.keychain.delete")
    static let invalidURL = value("error.invalid.url")
    static let invalidResponse = value("error.invalid.response")
    static let pairingExpired = value("error.pairing.expired")
    static let controlToolMissing = value("error.control.tool.missing")
    static let pairingCommandFailed = value("error.pairing.command")
    static let invalidPairingLink = value("error.invalid.pairing.link")

    static func driverName(_ id: String) -> String {
        String(format: value("driver.name.format"), id)
    }

    static func providerDriverName(_ name: String, model: String) -> String {
        String(format: value("provider.driver.name.format"), name, model)
    }

    static func editCollaboratorDriverDetail(_ name: String) -> String {
        String(format: value("collaborator.driver.edit.detail.format"), name)
    }

    static func objectCount(_ count: Int) -> String {
        String(format: value("object.count.format"), count)
    }

    static func initiativeMinutes(_ minutes: Int) -> String {
        String(format: value("initiative.minutes.format"), minutes)
    }

    static func initiativeDeliveries(_ count: Int) -> String {
        String(format: value("initiative.deliveries.format"), count)
    }

    static func attachmentCount(_ count: Int) -> String {
        String(format: value("attachment.count.format"), count)
    }

    static func keepLatestBackups(_ count: Int) -> String {
        String(format: keepLatestBackupsFormat, Int64(count))
    }

    static func backupSettingsLastApplied(_ date: String, deletedCount: Int) -> String {
        String(format: backupSettingsLastAppliedFormat, date, Int64(deletedCount))
    }

    static func toolCount(_ count: Int) -> String {
        String(format: value("tool.count.format"), count)
    }

    static func automaticAccessCount(_ count: Int) -> String {
        String(format: value("mcp.access.automatic.count.format"), count)
    }

    static func allToolsAutomaticDescription(_ count: Int) -> String {
        String(format: value("mcp.access.all.description.format"), count)
    }

    static func selectedToolsDescription(_ count: Int) -> String {
        String(format: value("mcp.access.selected.description.format"), count)
    }

    static func collaboratorTools(_ name: String) -> String {
        String(format: value("mcp.collaborator.tools.format"), name)
    }

    static func editCollaboratorTools(_ name: String) -> String {
        String(format: value("mcp.access.edit.title.format"), name)
    }

    static func selectedToolCount(_ count: Int) -> String {
        String(format: value("mcp.access.selected.count.format"), count)
    }

    static func surfaceCount(_ count: Int) -> String {
        String(format: value("surface.count.format"), count)
    }

    static func conversationAndSurfaceCount(_ conversationCount: Int, surfaceCount: Int) -> String {
        String(format: value("collaborator.content.count.format"), conversationCount, surfaceCount)
    }

    static func pendingApprovalCount(_ count: Int) -> String {
        String(format: value("conversation.approval.count.format"), count)
    }

    static func messageCount(_ count: Int) -> String {
        String(format: value("conversation.message.count.format"), count)
    }

    static func guidePairedPhoneCount(_ count: Int) -> String {
        String(format: value("guide.status.phone.count.format"), Int64(count))
    }

    static func guideCollaboratorCount(_ count: Int) -> String {
        String(format: value("guide.status.collaborator.count.format"), Int64(count))
    }

    static func guideConversationCount(_ count: Int) -> String {
        String(format: value("guide.status.conversation.count.format"), Int64(count))
    }

    static func surfaceVersion(_ ordinal: Int) -> String {
        String(format: value("surface.version.format"), ordinal)
    }

    static func unavailableSelectedTools(_ count: Int) -> String {
        String(format: value("mcp.access.unavailable.count.format"), count)
    }

    static func pluginEnabled(_ name: String) -> String { String(format: value("plugin.enabled.format"), name) }
    static func pluginDisabled(_ name: String) -> String { String(format: value("plugin.disabled.format"), name) }
    static func pluginValidationSucceeded(_ count: Int) -> String { String(format: value("plugin.validated.format"), count) }
    static func pluginDraftSaved(_ name: String) -> String { String(format: value("plugin.draft.saved.format"), name) }
    static func pluginDraftDeleted(_ name: String) -> String { String(format: value("plugin.draft.deleted.format"), name) }
    static func pluginApplied(_ name: String) -> String { String(format: value("plugin.applied.format"), name) }
    static func pluginRolledBack(_ name: String, _ version: String) -> String { String(format: value("plugin.rolled.back.format"), name, version) }
    static func updateAvailable(_ version: String) -> String { String(format: value("update.available.format"), version) }
    static func pluginUninstalled(_ name: String) -> String { String(format: value("plugin.uninstalled.format"), name) }
    static func pluginToolCount(_ count: Int) -> String { String(format: value("plugin.tool.count.format"), count) }

    static func days(_ count: Int64) -> String {
        String(format: value("days.format"), count)
    }

    static func hours(_ count: Int64) -> String {
        String(format: value("hours.format"), count)
    }

    static func minutes(_ count: Int64) -> String {
        String(format: value("minutes.format"), count)
    }
}

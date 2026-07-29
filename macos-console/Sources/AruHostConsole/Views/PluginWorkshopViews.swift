import SwiftUI

struct PluginEditorSeed: Identifiable {
    let id = UUID()
    let pluginId: String
    let displayName: String
    let version: String
    let sourceCode: String
    let capabilities: Set<String>
    let locksIdentity: Bool

    static let newPlugin = PluginEditorSeed(
        pluginId: "",
        displayName: "",
        version: "1.0.0",
        sourceCode: """
        export const tools = [{
          name: "hello",
          title: "Hello",
          description: "Return a greeting.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string" }
            }
          }
        }];

        export async function callTool(name, args) {
          if (name !== "hello") throw new Error("unknown tool");
          return { greeting: `Hello, ${args.name ?? "there"}` };
        }
        """,
        capabilities: [],
        locksIdentity: false
    )
}

struct PluginEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    let runtime: HostConsoleRuntime
    let seed: PluginEditorSeed

    @State private var pluginId: String
    @State private var displayName: String
    @State private var version: String
    @State private var sourceCode: String
    @State private var persistentStorage: Bool
    @State private var networkOutbound: Bool
    @State private var validation: HostPluginValidationResult?
    @State private var errorMessage: String?
    @State private var isWorking = false

    init(runtime: HostConsoleRuntime, seed: PluginEditorSeed) {
        self.runtime = runtime
        self.seed = seed
        _pluginId = State(initialValue: seed.pluginId)
        _displayName = State(initialValue: seed.displayName)
        _version = State(initialValue: seed.version)
        _sourceCode = State(initialValue: seed.sourceCode)
        _persistentStorage = State(initialValue: seed.capabilities.contains("persistent-storage"))
        _networkOutbound = State(initialValue: seed.capabilities.contains("network-outbound"))
    }

    private var mutation: HostPluginSourceMutation {
        var capabilities: [String] = []
        if persistentStorage { capabilities.append("persistent-storage") }
        if networkOutbound { capabilities.append("network-outbound") }
        return HostPluginSourceMutation(
            pluginId: pluginId.trimmingCharacters(in: .whitespacesAndNewlines),
            displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines),
            version: version.trimmingCharacters(in: .whitespacesAndNewlines),
            sourceCode: sourceCode,
            capabilities: capabilities
        )
    }

    private var canSubmit: Bool {
        !pluginId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !version.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !sourceCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !isWorking
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Color.white.opacity(0.38))
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    identityFields
                    permissionFields
                    sourceEditor
                    if let validation { validationPanel(validation) }
                    if let errorMessage { SectionErrorBanner(message: errorMessage) }
                }
                .padding(26)
            }
            Divider().overlay(Color.white.opacity(0.38))
            actionFooter
        }
        .frame(minWidth: 820, idealWidth: 920, minHeight: 680, idealHeight: 780)
        .background(BorrowedLightWeather())
        .onChange(of: pluginId) { _, _ in invalidateValidation() }
        .onChange(of: displayName) { _, _ in invalidateValidation() }
        .onChange(of: version) { _, _ in invalidateValidation() }
        .onChange(of: sourceCode) { _, _ in invalidateValidation() }
        .onChange(of: persistentStorage) { _, _ in invalidateValidation() }
        .onChange(of: networkOutbound) { _, _ in invalidateValidation() }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 18) {
            VStack(alignment: .leading, spacing: 5) {
                Text(seed.pluginId.isEmpty ? L10n.pluginEditorNew : L10n.pluginEditorEdit)
                    .font(.system(size: 25, weight: .light, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                Text(L10n.pluginEditorDescription)
                    .font(.system(size: 11, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.66))
            }
            Spacer()
            Button(L10n.cancel) { dismiss() }
                .buttonStyle(FloatingGlassButtonStyle())
        }
        .padding(24)
    }

    private var identityFields: some View {
        ReadablePanel {
            HStack(alignment: .top, spacing: 16) {
                PluginField(title: L10n.pluginID, text: $pluginId, monospaced: true)
                    .disabled(seed.locksIdentity)
                PluginField(title: L10n.pluginDisplayName, text: $displayName)
                PluginField(title: L10n.pluginVersion, text: $version, monospaced: true)
                    .frame(maxWidth: 180)
            }
        }
    }

    private var permissionFields: some View {
        ReadablePanel {
            VStack(alignment: .leading, spacing: 14) {
                Text(L10n.pluginCapabilityGrants)
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                HStack(spacing: 18) {
                    Toggle(L10n.persistentStorage, isOn: $persistentStorage)
                    Toggle(L10n.networkOutbound, isOn: $networkOutbound)
                }
                .toggleStyle(.switch)
                if !persistentStorage && !networkOutbound {
                    Label(L10n.zeroAuthority, systemImage: "checkmark.shield")
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(HostPalette.mint)
                }
            }
        }
    }

    private var sourceEditor: some View {
        ReadablePanel {
            VStack(alignment: .leading, spacing: 10) {
                Text(L10n.pluginSourceCode)
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                Text(L10n.pluginSourceDescription)
                    .font(.system(size: 10, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.60))
                TextEditor(text: $sourceCode)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(HostPalette.ink)
                    .scrollContentBackground(.hidden)
                    .padding(12)
                    .frame(minHeight: 330)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Color.white.opacity(0.32)))
                    .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.white.opacity(0.48), lineWidth: 0.7))
            }
        }
    }

    private func validationPanel(_ result: HostPluginValidationResult) -> some View {
        ReadablePanel {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label(L10n.pluginValidationSucceeded(result.tools.count), systemImage: "checkmark.seal")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.mint)
                    Spacer()
                    Text(result.digest)
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.52))
                        .lineLimit(1)
                }
                ToolSummaryGrid(tools: result.tools)
            }
        }
    }

    private var actionFooter: some View {
        HStack(spacing: 12) {
            if isWorking { ProgressView().controlSize(.small) }
            Spacer()
            Button(L10n.pluginValidate) { performValidation() }
                .buttonStyle(FloatingGlassButtonStyle())
                .disabled(!canSubmit)
            Button(L10n.pluginSaveDraft) {
                performMutation { _ = try await runtime.savePluginDraft(mutation); dismiss() }
            }
            .buttonStyle(FloatingGlassButtonStyle())
            .disabled(!canSubmit)
            Button(L10n.pluginApply) {
                performMutation { _ = try await runtime.applyPluginSource(mutation); dismiss() }
            }
            .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.mint.opacity(0.22)))
            .disabled(!canSubmit)
        }
        .padding(22)
    }

    private func performValidation() {
        guard !isWorking else { return }
        isWorking = true
        errorMessage = nil
        Task {
            do {
                validation = try await runtime.validatePluginSource(mutation)
            } catch {
                errorMessage = error.localizedDescription
                runtime.reportPluginActionFailure(error)
            }
            isWorking = false
        }
    }

    private func performMutation(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !isWorking else { return }
        isWorking = true
        errorMessage = nil
        Task {
            do { try await operation() }
            catch {
                errorMessage = error.localizedDescription
                runtime.reportPluginActionFailure(error)
            }
            isWorking = false
        }
    }

    private func invalidateValidation() { validation = nil }
}

private struct PluginField: View {
    let title: String
    @Binding var text: String
    var monospaced = false

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(.system(size: 10, weight: .medium, design: .rounded))
                .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
            TextField(title, text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 13, design: monospaced ? .monospaced : .rounded))
                .padding(.horizontal, 12)
                .frame(height: 38)
                .background(RoundedRectangle(cornerRadius: 13).fill(Color.white.opacity(0.30)))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct PluginDraftRow: View {
    let draft: HostPluginDraft
    let isBusy: Bool
    let edit: () -> Void
    let apply: () -> Void
    let delete: () -> Void

    var body: some View {
        ReadablePanel {
            HStack(spacing: 14) {
                StatusGlyph(state: .waiting)
                VStack(alignment: .leading, spacing: 4) {
                    Text(draft.displayName)
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text("\(draft.target == "update" ? L10n.pluginDraftUpdate : L10n.pluginDraftCreate) · \(draft.version) · \(L10n.pluginToolCount(draft.tools.count))")
                        .font(.system(size: 10, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.60))
                }
                Spacer()
                PermissionPills(permissions: draft.permissions)
                Button(L10n.edit, action: edit).buttonStyle(FloatingGlassButtonStyle())
                Button(L10n.applyNow, action: apply)
                    .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.mint.opacity(0.18)))
                Button(action: delete) { Image(systemName: "trash") }
                    .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.rose.opacity(0.14)))
            }
            .disabled(isBusy)
        }
    }
}

struct PluginSelectionRow: View {
    let plugin: HostPlugin
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                StatusGlyph(state: plugin.statusGlyph)
                VStack(alignment: .leading, spacing: 3) {
                    Text(plugin.manifest.displayName)
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text("\(plugin.manifest.version) · \(L10n.pluginToolCount(plugin.tools.count))")
                        .font(.system(size: 9, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.58))
                }
                Spacer()
            }
            .padding(13)
            .background(RoundedRectangle(cornerRadius: 19).fill(selected ? Color.white.opacity(0.38) : Color.white.opacity(0.18)))
            .overlay(RoundedRectangle(cornerRadius: 19).stroke(selected ? HostPalette.lavender.opacity(0.34) : Color.white.opacity(0.30), lineWidth: 0.7))
        }
        .buttonStyle(.plain)
    }
}

struct PluginDetailPanel: View {
    let plugin: HostPlugin
    let collaborators: [HostedCollaborator]
    let isBusy: Bool
    let toggle: () -> Void
    let edit: () -> Void
    let rollback: () -> Void
    let uninstall: () -> Void

    var body: some View {
        ReadablePanel {
            VStack(alignment: .leading, spacing: 19) {
                HStack(alignment: .top, spacing: 14) {
                    StatusGlyph(state: plugin.statusGlyph)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(plugin.manifest.displayName)
                            .font(.system(size: 20, weight: .medium, design: .rounded))
                            .foregroundStyle(HostPalette.ink)
                        Text(plugin.statusLabel)
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .foregroundStyle(plugin.health == "running" ? HostPalette.mint : plugin.health == "unhealthy" ? HostPalette.rose : HostPalette.amber)
                    }
                    Spacer()
                    Text(plugin.manifest.version)
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(Capsule().fill(Color.white.opacity(0.28)))
                }

                if let error = plugin.lastErrorMessage ?? plugin.lastErrorCode {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(L10n.lastError)
                            .font(.system(size: 10, weight: .semibold, design: .rounded))
                        Text(error)
                            .font(.system(size: 10, design: .monospaced))
                            .textSelection(.enabled)
                    }
                    .foregroundStyle(HostPalette.rose)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 15).fill(HostPalette.rose.opacity(0.08)))
                }

                HStack(spacing: 16) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(L10n.installed).font(.system(size: 9, design: .rounded))
                        Text(HostFormat.date(plugin.installedAt)).font(.system(size: 10, weight: .medium, design: .rounded))
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(L10n.updated).font(.system(size: 9, design: .rounded))
                        Text(HostFormat.date(plugin.updatedAt)).font(.system(size: 10, weight: .medium, design: .rounded))
                    }
                    Spacer()
                    PermissionPills(permissions: plugin.manifest.permissions)
                }
                .foregroundStyle(HostPalette.secondaryInk.opacity(0.68))

                Divider().overlay(Color.white.opacity(0.40))
                VStack(alignment: .leading, spacing: 10) {
                    Text(L10n.pluginTools)
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    if plugin.tools.isEmpty { Text(L10n.noPluginTools).font(.system(size: 11, design: .rounded)) }
                    else { ToolSummaryGrid(tools: plugin.tools) }
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text(L10n.pluginCollaborators)
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    if collaborators.isEmpty {
                        Text(L10n.noPluginCollaborators)
                            .font(.system(size: 11, design: .rounded))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.60))
                    } else {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), spacing: 7)], alignment: .leading, spacing: 7) {
                            ForEach(collaborators) { collaborator in
                                let access = pluginAccess(for: collaborator)
                                HStack(spacing: 5) {
                                    HostedCollaboratorAvatar(
                                        collaborator: collaborator,
                                        size: 20,
                                        statusColor: access.color
                                    )
                                    Text(collaborator.displayName)
                                    Text(access.label)
                                        .opacity(0.56)
                                }
                                .font(.system(size: 9, weight: .medium, design: .rounded))
                                .foregroundStyle(HostPalette.secondaryInk.opacity(0.72))
                                .padding(.horizontal, 9)
                                .padding(.vertical, 6)
                                .background(Capsule().fill(Color.white.opacity(0.24)))
                            }
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text(L10n.lifecycleActivity)
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    if plugin.events.isEmpty {
                        Text(L10n.noLifecycleActivity).font(.system(size: 11, design: .rounded))
                    } else {
                        ForEach(plugin.events.reversed()) { event in
                            HStack(spacing: 9) {
                                Circle().fill(event.result == "succeeded" ? HostPalette.mint : HostPalette.rose).frame(width: 7, height: 7)
                                Text(event.displayAction)
                                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                                Text(event.version)
                                    .font(.system(size: 9, design: .monospaced))
                                Spacer()
                                Text(HostFormat.date(event.createdAt))
                                    .font(.system(size: 9, design: .rounded))
                                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.52))
                            }
                        }
                    }
                }

                HStack(spacing: 10) {
                    Button(plugin.desiredState == "enabled" ? L10n.disable : L10n.enable, action: toggle)
                        .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.mint.opacity(0.16)))
                    if plugin.manifest.packageMode == "source-node" {
                        Button(L10n.editSource, action: edit).buttonStyle(FloatingGlassButtonStyle())
                    }
                    if plugin.rollbackAvailable {
                        Button(L10n.rollback, action: rollback).buttonStyle(FloatingGlassButtonStyle())
                    }
                    Spacer()
                    Button(L10n.uninstall, action: uninstall)
                        .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.rose.opacity(0.15)))
                }
                .disabled(isBusy)
            }
        }
    }

    private func pluginAccess(for collaborator: HostedCollaborator) -> (label: String, color: Color) {
        if collaborator.toolAccess.mode == .all {
            return (L10n.pluginAccessAll, HostPalette.mint)
        }
        let names = Set(plugin.tools.map { "plugin__\(plugin.manifest.pluginId.replacingOccurrences(of: ".", with: "_"))__\($0.name)" })
        let admitted = names.intersection(collaborator.toolAccess.toolNames).count
        if admitted == 0 { return (L10n.pluginAccessNone, HostPalette.secondaryInk.opacity(0.34)) }
        if admitted == names.count { return (L10n.pluginAccessAll, HostPalette.mint) }
        return (L10n.pluginAccessPartial, HostPalette.amber)
    }
}

struct PermissionPills: View {
    let permissions: HostPluginPermissions

    var body: some View {
        HStack(spacing: 6) {
            if permissions.network == "outbound" { pill(L10n.networkOutbound, "network") }
            if permissions.persistentVolume { pill(L10n.persistentStorage, "externaldrive") }
            if permissions.network == "none" && !permissions.persistentVolume { pill(L10n.zeroAuthority, "checkmark.shield") }
        }
    }

    private func pill(_ title: String, _ symbol: String) -> some View {
        Label(title, systemImage: symbol)
            .font(.system(size: 9, weight: .medium, design: .rounded))
            .foregroundStyle(HostPalette.secondaryInk.opacity(0.68))
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(Capsule().fill(Color.white.opacity(0.25)))
    }
}

struct ToolSummaryGrid: View {
    let tools: [MCPToolSummary]

    var body: some View {
        VStack(spacing: 7) {
            ForEach(tools) { tool in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "wrench.adjustable")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(HostPalette.lavenderDeep)
                        .frame(width: 22, height: 22)
                        .background(Circle().fill(HostPalette.lavender.opacity(0.10)))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(tool.title ?? tool.name)
                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                            .foregroundStyle(HostPalette.ink)
                        Text(tool.name)
                            .font(.system(size: 8, design: .monospaced))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.50))
                        if let description = tool.description {
                            Text(description)
                                .font(.system(size: 9, design: .rounded))
                                .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
                        }
                    }
                    Spacer()
                }
                .padding(9)
                .background(RoundedRectangle(cornerRadius: 13).fill(Color.white.opacity(0.18)))
            }
        }
    }
}

struct PluginActionBanner: View {
    let message: String
    let failed: Bool
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: failed ? "exclamationmark.triangle" : "checkmark.circle")
            Text(message)
                .font(.system(size: 11, weight: .medium, design: .rounded))
            Spacer()
            Button(action: dismiss) { Image(systemName: "xmark") }
                .buttonStyle(.plain)
        }
        .foregroundStyle(failed ? HostPalette.rose : HostPalette.mint)
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(RoundedRectangle(cornerRadius: 15).fill((failed ? HostPalette.rose : HostPalette.mint).opacity(0.09)))
    }
}

private extension HostPlugin {
    var statusGlyph: StatusGlyph.State {
        health == "running" ? .ready : health == "unhealthy" ? .unavailable : .waiting
    }

    var statusLabel: String {
        health == "running" ? L10n.pluginRunning : health == "unhealthy" ? L10n.pluginUnhealthy : L10n.pluginDisabled
    }
}

private extension HostPluginEvent {
    var displayAction: String {
        switch action {
        case "installed": L10n.installed
        case "published", "upgraded": L10n.updated
        case "enabled": L10n.enable
        case "disabled": L10n.disable
        case "rolled-back": L10n.rollback
        default: action
        }
    }
}

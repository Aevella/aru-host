import SwiftUI

struct MCPGatewayView: View {
    let runtime: HostConsoleRuntime
    @State private var query = ""
    @State private var scope: MCPDirectoryScope = .all
    @State private var collaboratorForEditing: HostedCollaborator?

    private var catalog: [MCPToolSummary] {
        runtime.mcpGateway?.tools ?? []
    }

    private var selectedCollaborator: HostedCollaborator? {
        guard case .collaborator(let id) = scope else { return nil }
        return runtime.collaborators.first { $0.id == id }
    }

    private var scopedTools: [MCPToolSummary] {
        guard let selectedCollaborator else { return catalog }
        return catalog.filter { selectedCollaborator.toolAccess.admits($0.name) }
    }

    private var visibleTools: [MCPToolSummary] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return scopedTools }
        return scopedTools.filter { tool in
            let plugin = pluginForTool(tool)
            return [tool.name, tool.title, tool.description, plugin?.manifest.displayName]
                .compactMap { $0?.lowercased() }
                .contains { $0.contains(normalized) }
        }
    }

    private var customizedCollaboratorCount: Int {
        runtime.collaborators.filter { $0.toolAccess.mode == .selected }.count
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HostSectionHeader(
                    title: L10n.mcpGateway,
                    subtitle: L10n.mcpSubtitle
                )
                if let error = runtime.sectionErrors[.mcp] {
                    SectionErrorBanner(message: error)
                }

                gatewaySummary

                if let gateway = runtime.mcpGateway {
                    HStack(spacing: 12) {
                        StatTile(label: L10n.allTools, value: "\(gateway.tools.count)", detail: gateway.protocolVersion)
                        StatTile(label: L10n.computerCollaborators, value: "\(runtime.collaborators.count)", detail: L10n.collaboratorClassification)
                        StatTile(label: L10n.customToolAccess, value: "\(customizedCollaboratorCount)", detail: L10n.automaticAccessCount(runtime.collaborators.count - customizedCollaboratorCount))
                    }

                    directoryControls

                    if let selectedCollaborator {
                        collaboratorAccessSummary(selectedCollaborator)
                    }

                    toolDirectory
                }
            }
            .padding(30)
        }
        .onChange(of: runtime.collaborators.map(\.id)) { _, ids in
            if case .collaborator(let id) = scope, !ids.contains(id) {
                scope = .all
            }
        }
        .sheet(item: $collaboratorForEditing) { collaborator in
            CollaboratorToolAccessSheet(
                runtime: runtime,
                collaborator: collaborator,
                tools: catalog,
                plugins: runtime.plugins
            )
        }
    }

    private var gatewaySummary: some View {
        ReadablePanel {
            HStack(spacing: 16) {
                StatusGlyph(state: runtime.mcpGateway == nil ? .waiting : .ready)
                VStack(alignment: .leading, spacing: 5) {
                    Text(runtime.mcpGateway?.serverName ?? L10n.mcpGateway)
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(L10n.mcpAuthenticatedDescription)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.64))
                }
                Spacer()
                if let gateway = runtime.mcpGateway {
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(L10n.toolCount(gateway.tools.count))
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .foregroundStyle(HostPalette.mint)
                        Text(gateway.serverVersion)
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.50))
                    }
                }
            }
        }
    }

    private var directoryControls: some View {
        ReadablePanel {
            VStack(alignment: .leading, spacing: 15) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.52))
                    TextField(L10n.searchTools, text: $query)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12, design: .rounded))
                }
                .padding(.horizontal, 13)
                .frame(height: 40)
                .background {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.white.opacity(0.28))
                        .overlay {
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .stroke(Color.white.opacity(0.42), lineWidth: 0.7)
                        }
                }

                VStack(alignment: .leading, spacing: 9) {
                    Text(L10n.viewByCollaborator)
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 9) {
                            collaboratorScopeButton(
                                title: L10n.wholeHost,
                                detail: L10n.toolCount(catalog.count),
                                symbol: "sparkles.rectangle.stack",
                                target: .all
                            )
                            ForEach(runtime.collaborators) { collaborator in
                                collaboratorScopeButton(
                                    title: collaborator.displayName,
                                    detail: collaborator.toolAccess.mode == .all
                                        ? L10n.accessAllShort
                                        : L10n.toolCount(catalog.filter { collaborator.toolAccess.admits($0.name) }.count),
                                    symbol: "person.crop.circle",
                                    collaborator: collaborator,
                                    target: .collaborator(collaborator.id)
                                )
                            }
                        }
                    }

                    if runtime.collaborators.isEmpty {
                        Label(L10n.noCollaboratorClassification, systemImage: "person.crop.circle.badge.plus")
                            .font(.system(size: 10, design: .rounded))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.58))
                    }
                }
            }
        }
    }

    private func collaboratorScopeButton(
        title: String,
        detail: String,
        symbol: String,
        collaborator: HostedCollaborator? = nil,
        target: MCPDirectoryScope
    ) -> some View {
        Button {
            withAnimation(.snappy(duration: 0.24)) { scope = target }
        } label: {
            HStack(spacing: 8) {
                if let collaborator {
                    HostedCollaboratorAvatar(collaborator: collaborator, size: 22)
                } else {
                    Image(systemName: symbol)
                        .font(.system(size: 11, weight: .semibold))
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                    Text(detail)
                        .font(.system(size: 8, weight: .medium, design: .rounded))
                        .opacity(0.62)
                }
            }
        }
        .buttonStyle(CollaboratorScopeButtonStyle(isSelected: scope == target))
    }

    private func collaboratorAccessSummary(_ collaborator: HostedCollaborator) -> some View {
        ReadablePanel {
            HStack(spacing: 14) {
                HostedCollaboratorAvatar(collaborator: collaborator, size: 38)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 7) {
                        Text(collaborator.displayName)
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .foregroundStyle(HostPalette.ink)
                        Text(L10n.driverName(collaborator.driverId))
                            .font(.system(size: 9, weight: .medium, design: .rounded))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.54))
                    }
                    Text(accessDescription(collaborator))
                        .font(.system(size: 10, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.64))
                }
                Spacer()
                Button(L10n.editToolAccess) {
                    collaboratorForEditing = collaborator
                }
                .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.20)))
            }
        }
    }

    private var toolDirectory: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(selectedCollaborator.map { L10n.collaboratorTools($0.displayName) } ?? L10n.toolDirectory)
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    if let selectedCollaborator {
                        Text(accessDescription(selectedCollaborator))
                            .font(.system(size: 10, design: .rounded))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.56))
                    }
                }
                Spacer()
                Text(L10n.toolCount(visibleTools.count))
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.lavenderDeep)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Capsule().fill(Color.white.opacity(0.26)))
            }

            if visibleTools.isEmpty {
                EmptySectionState(
                    symbol: query.isEmpty ? "wrench.and.screwdriver" : "magnifyingglass",
                    title: query.isEmpty ? L10n.noToolsForCollaborator : L10n.noMatchingTools,
                    detail: query.isEmpty ? L10n.noToolsForCollaboratorDetail : L10n.mcpAuthenticatedDescription
                )
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(visibleTools) { tool in
                        let plugin = pluginForTool(tool)
                        MCPToolRow(
                            tool: tool,
                            source: plugin?.manifest.displayName ?? L10n.officialHost,
                            isPlugin: plugin != nil
                        )
                    }
                }
            }
        }
    }

    private func accessDescription(_ collaborator: HostedCollaborator) -> String {
        switch collaborator.toolAccess.mode {
        case .all:
            L10n.allToolsAutomaticDescription(catalog.count)
        case .selected:
            L10n.selectedToolsDescription(catalog.filter { collaborator.toolAccess.admits($0.name) }.count)
        }
    }

    private func pluginForTool(_ tool: MCPToolSummary) -> HostPlugin? {
        runtime.plugins.first { plugin in
            tool.name.hasPrefix("plugin__\(safePluginID(plugin.id))__")
        }
    }
}

private enum MCPDirectoryScope: Equatable {
    case all
    case collaborator(String)
}

private struct CollaboratorScopeButtonStyle: ButtonStyle {
    let isSelected: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isSelected ? HostPalette.lavenderDeep : HostPalette.secondaryInk.opacity(0.72))
            .padding(.horizontal, 13)
            .frame(minHeight: 43)
            .background {
                Capsule()
                    .fill(
                        isSelected
                            ? LinearGradient(
                                colors: [HostPalette.lavender.opacity(0.22), HostPalette.rose.opacity(0.10)],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                            : LinearGradient(colors: [Color.white.opacity(0.22)], startPoint: .leading, endPoint: .trailing)
                    )
                    .glassEffect(
                        .regular.tint(isSelected ? HostPalette.lavender.opacity(0.10) : Color.white.opacity(0.05)).interactive(),
                        in: Capsule()
                    )
                    .overlay {
                        Capsule().stroke(Color.white.opacity(isSelected ? 0.72 : 0.38), lineWidth: 0.7)
                    }
                    .shadow(color: isSelected ? HostPalette.lavenderDeep.opacity(0.12) : .clear, radius: 12, y: 5)
            }
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.snappy(duration: 0.18), value: configuration.isPressed)
    }
}

private struct CollaboratorToolAccessSheet: View {
    let runtime: HostConsoleRuntime
    let collaborator: HostedCollaborator
    let tools: [MCPToolSummary]
    let plugins: [HostPlugin]

    @Environment(\.dismiss) private var dismiss
    @State private var mode: HostedCollaboratorToolAccessMode
    @State private var selectedToolNames: Set<String>
    @State private var query = ""
    @State private var errorMessage: String?

    init(
        runtime: HostConsoleRuntime,
        collaborator: HostedCollaborator,
        tools: [MCPToolSummary],
        plugins: [HostPlugin]
    ) {
        self.runtime = runtime
        self.collaborator = collaborator
        self.tools = tools
        self.plugins = plugins
        _mode = State(initialValue: collaborator.toolAccess.mode)
        _selectedToolNames = State(initialValue: collaborator.toolAccess.mode == .all
            ? Set(tools.map(\.name))
            : Set(collaborator.toolAccess.toolNames))
    }

    private var filteredTools: [MCPToolSummary] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return tools }
        return tools.filter { tool in
            let source = pluginForTool(tool)?.manifest.displayName
            return [tool.name, tool.title, tool.description, source]
                .compactMap { $0?.lowercased() }
                .contains { $0.contains(normalized) }
        }
    }

    private var hostTools: [MCPToolSummary] {
        filteredTools.filter { pluginForTool($0) == nil }
    }

    private var pluginTools: [MCPToolSummary] {
        filteredTools.filter { pluginForTool($0) != nil }
    }

    private var hasChanges: Bool {
        let newAccess = proposedAccess
        return newAccess.mode != collaborator.toolAccess.mode
            || Set(newAccess.toolNames) != Set(collaborator.toolAccess.toolNames)
    }

    private var proposedAccess: HostedCollaboratorToolAccess {
        mode == .all ? .all : .selected(selectedToolNames)
    }

    var body: some View {
        ZStack {
            BorrowedLightWeather()
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L10n.editCollaboratorTools(collaborator.displayName))
                        .font(.system(size: 25, weight: .light, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(L10n.toolAccessExplanation)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.68))
                }

                HStack(spacing: 11) {
                    accessModeButton(
                        mode: .all,
                        symbol: "sparkles",
                        title: L10n.automaticAllTools,
                        detail: L10n.automaticAllToolsDetail
                    )
                    accessModeButton(
                        mode: .selected,
                        symbol: "slider.horizontal.3",
                        title: L10n.chooseTools,
                        detail: L10n.selectedToolCount(selectedToolNames.intersection(tools.map(\.name)).count)
                    )
                }

                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.48))
                    TextField(L10n.searchTools, text: $query)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12, design: .rounded))
                }
                .padding(.horizontal, 13)
                .frame(height: 40)
                .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.28)))

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        toolGroup(L10n.hostTools, tools: hostTools)
                        toolGroup(L10n.pluginProvidedTools, tools: pluginTools)
                        let unavailable = selectedToolNames.subtracting(tools.map(\.name))
                        if !unavailable.isEmpty {
                            Label(L10n.unavailableSelectedTools(unavailable.count), systemImage: "clock.badge.exclamationmark")
                                .font(.system(size: 10, design: .rounded))
                                .foregroundStyle(HostPalette.amber)
                        }
                    }
                    .padding(.vertical, 2)
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.rose)
                }

                HStack {
                    Button(L10n.cancel) { dismiss() }
                        .buttonStyle(FloatingGlassButtonStyle())
                    Spacer()
                    Button {
                        Task {
                            do {
                                try await runtime.updateToolAccess(for: collaborator, toolAccess: proposedAccess)
                                dismiss()
                            } catch {
                                errorMessage = error.localizedDescription
                            }
                        }
                    } label: {
                        HStack(spacing: 8) {
                            if runtime.mutatingCollaboratorIds.contains(collaborator.id) {
                                ProgressView().controlSize(.small)
                            }
                            Text(L10n.saveToolAccess)
                        }
                    }
                    .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.24)))
                    .disabled(!hasChanges || runtime.mutatingCollaboratorIds.contains(collaborator.id))
                    .opacity(hasChanges ? 1 : 0.45)
                }
            }
            .padding(26)
        }
        .frame(width: 720, height: 700)
    }

    private func accessModeButton(
        mode target: HostedCollaboratorToolAccessMode,
        symbol: String,
        title: String,
        detail: String
    ) -> some View {
        Button {
            if target == .selected, mode == .all {
                selectedToolNames.formUnion(tools.map(\.name))
            }
            withAnimation(.snappy(duration: 0.22)) { mode = target }
        } label: {
            HStack(spacing: 11) {
                Image(systemName: symbol)
                    .font(.system(size: 13, weight: .semibold))
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(HostPalette.lavender.opacity(0.12)))
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                    Text(detail)
                        .font(.system(size: 9, design: .rounded))
                        .opacity(0.62)
                }
                Spacer()
                Image(systemName: self.mode == target ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(self.mode == target ? HostPalette.lavenderDeep : HostPalette.secondaryInk.opacity(0.30))
            }
            .padding(13)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(AccessModeButtonStyle(isSelected: self.mode == target))
    }

    @ViewBuilder
    private func toolGroup(_ title: String, tools groupTools: [MCPToolSummary]) -> some View {
        if !groupTools.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(title)
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.58))
                ReadablePanel {
                    VStack(spacing: 0) {
                        ForEach(groupTools) { tool in
                            toolSelectionRow(tool)
                            if tool.id != groupTools.last?.id {
                                Divider().padding(.leading, 42).overlay(Color.white.opacity(0.34))
                            }
                        }
                    }
                }
            }
        }
    }

    private func toolSelectionRow(_ tool: MCPToolSummary) -> some View {
        let isSelected = mode == .all || selectedToolNames.contains(tool.name)
        return Button {
            if mode == .all {
                mode = .selected
                selectedToolNames.formUnion(tools.map(\.name))
            }
            if selectedToolNames.contains(tool.name) {
                selectedToolNames.remove(tool.name)
            } else {
                selectedToolNames.insert(tool.name)
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(isSelected ? HostPalette.mint : HostPalette.secondaryInk.opacity(0.30))
                    .frame(width: 26)
                VStack(alignment: .leading, spacing: 3) {
                    Text(tool.title ?? tool.name)
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    HStack(spacing: 6) {
                        Text(tool.name)
                            .font(.system(size: 8, design: .monospaced))
                        if let plugin = pluginForTool(tool) {
                            Text(plugin.manifest.displayName)
                                .font(.system(size: 8, weight: .medium, design: .rounded))
                        }
                    }
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.52))
                }
                Spacer()
            }
            .contentShape(Rectangle())
            .padding(.vertical, 9)
        }
        .buttonStyle(.plain)
    }

    private func pluginForTool(_ tool: MCPToolSummary) -> HostPlugin? {
        plugins.first { tool.name.hasPrefix("plugin__\(safePluginID($0.id))__") }
    }
}

private struct AccessModeButtonStyle: ButtonStyle {
    let isSelected: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isSelected ? HostPalette.lavenderDeep : HostPalette.secondaryInk.opacity(0.74))
            .background {
                RoundedRectangle(cornerRadius: 17, style: .continuous)
                    .fill(isSelected ? HostPalette.lavender.opacity(0.12) : Color.white.opacity(0.20))
                    .overlay {
                        RoundedRectangle(cornerRadius: 17, style: .continuous)
                            .stroke(Color.white.opacity(isSelected ? 0.68 : 0.36), lineWidth: 0.8)
                    }
            }
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.snappy(duration: 0.16), value: configuration.isPressed)
    }
}

private struct MCPToolRow: View {
    let tool: MCPToolSummary
    let source: String
    let isPlugin: Bool

    var body: some View {
        ReadablePanel {
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 12) {
                    if let description = tool.description, !description.isEmpty {
                        Text(description)
                            .font(.system(size: 11, design: .rounded))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.68))
                    }
                    annotationPills
                    VStack(alignment: .leading, spacing: 6) {
                        Text(L10n.toolInputContract)
                            .font(.system(size: 10, weight: .semibold, design: .rounded))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.64))
                        Text(tool.inputSchema.prettyPrinted)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(HostPalette.ink.opacity(0.82))
                            .textSelection(.enabled)
                            .padding(11)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 13).fill(Color.white.opacity(0.20)))
                    }
                }
                .padding(.top, 12)
            } label: {
                HStack(alignment: .top, spacing: 14) {
                    Image(systemName: isPlugin ? "puzzlepiece.extension" : "wrench.and.screwdriver")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(isPlugin ? HostPalette.mint : HostPalette.lavenderDeep)
                        .frame(width: 28, height: 28)
                        .background(Circle().fill((isPlugin ? HostPalette.mint : HostPalette.lavender).opacity(0.12)))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(tool.title ?? tool.name)
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundStyle(HostPalette.ink)
                        Text(tool.name)
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.54))
                    }
                    Spacer()
                    Text(source)
                        .font(.system(size: 9, weight: .medium, design: .rounded))
                        .foregroundStyle(isPlugin ? HostPalette.mint : HostPalette.secondaryInk.opacity(0.55))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 6)
                        .background(Capsule().fill(Color.white.opacity(0.24)))
                }
            }
            .tint(HostPalette.lavenderDeep)
        }
    }

    @ViewBuilder
    private var annotationPills: some View {
        HStack(spacing: 7) {
            if tool.annotations?.readOnlyHint == true { pill(L10n.readOnly, HostPalette.mint) }
            if tool.annotations?.destructiveHint == true { pill(L10n.destructive, HostPalette.rose) }
            if tool.annotations?.idempotentHint == true { pill(L10n.idempotent, HostPalette.lavenderDeep) }
            if tool.annotations?.openWorldHint == true { pill(L10n.openWorld, HostPalette.amber) }
        }
    }

    private func pill(_ title: String, _ color: Color) -> some View {
        Text(title)
            .font(.system(size: 9, weight: .medium, design: .rounded))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Capsule().fill(color.opacity(0.09)))
    }
}

private func safePluginID(_ id: String) -> String {
    String(id.map { character in
        character.isLetter || character.isNumber || character == "_" || character == "-" ? character : "_"
    })
}

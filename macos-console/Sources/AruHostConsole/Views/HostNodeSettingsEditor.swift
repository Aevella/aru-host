import SwiftUI

struct HostNodeSettingsEditor: View {
    let supportsAddresses: Bool
    let primaryKind: String?
    let revision: Int
    let primaryAddress: String?
    let save: (String, [HostConnectionAddress]?, Int) async throws -> Void
    let verify: (String) async throws -> Void
    let cancel: () -> Void
    @State private var displayName: String
    @State private var addresses: [HostConnectionAddress]
    @State private var isSaving = false
    @State private var checkingID: String?
    @State private var checks: [String: String] = [:]
    @State private var errorMessage: String?

    init(settings: HostNodeSettings?, supportsAddresses: Bool,
         save: @escaping (String, [HostConnectionAddress]?, Int) async throws -> Void,
         verify: @escaping (String) async throws -> Void, cancel: @escaping () -> Void) {
        self.primaryKind = settings?.transportProfiles?.first(where: { $0.id == "primary" })?.kind
        self.revision = settings?.revision ?? 1
        self.supportsAddresses = supportsAddresses
        self.primaryAddress = settings?.transportProfiles?.first(where: { $0.id == "primary" })?.baseUrl
        self.save = save; self.verify = verify; self.cancel = cancel
        _displayName = State(initialValue: settings?.displayName ?? "")
        _addresses = State(initialValue: settings?.additionalTransports ?? [])
    }

    var body: some View {
        ZStack {
            BorrowedLightWeather()
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(L10n.nodeSettingsTitle)
                        .font(.system(size: 27, weight: .light, design: .rounded))
                    Text(L10n.nodeSettingsDetail).font(.system(size: 12))
                        .foregroundStyle(HostPalette.secondaryInk)
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text(L10n.nodeName).font(.system(size: 12, weight: .medium))
                    TextField(L10n.nodeName, text: $displayName).textFieldStyle(.roundedBorder)
                }
                Divider().opacity(0.4)
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(L10n.connectionsTitle).font(.system(size: 17, weight: .medium, design: .rounded))
                            Text(L10n.connectionsDetail).font(.system(size: 12))
                                .foregroundStyle(HostPalette.secondaryInk)
                        }
                        if let primaryAddress {
                            Label(primaryKind == "lan" ? L10n.connectionLocal : L10n.connectionPrimary, systemImage: primaryKind == "lan" ? "wifi" : "network")
                                .font(.system(size: 12, weight: .medium))
                            Text(primaryAddress).font(.system(size: 12, design: .monospaced))
                                .textSelection(.enabled).foregroundStyle(HostPalette.secondaryInk)
                        }
                        if supportsAddresses {
                            if addresses.isEmpty {
                                Text(L10n.connectionEmpty).font(.system(size: 12))
                                    .foregroundStyle(HostPalette.secondaryInk)
                            }
                            ForEach($addresses) { $address in
                                VStack(alignment: .leading, spacing: 10) {
                                    HStack {
                                        Image(systemName: address.kind == "tailscale" ? "point.3.connected.trianglepath.dotted" : "lock.shield")
                                        Picker("", selection: $address.kind) {
                                            Text("Tailscale").tag("tailscale")
                                            Text("HTTPS").tag("public-https")
                                        }.labelsHidden().frame(width: 150)
                                        Spacer()
                                        Button { addresses.removeAll { $0.id == address.id }; checks[address.id] = nil } label: {
                                            Image(systemName: "minus.circle")
                                        }.buttonStyle(.plain).help(L10n.connectionRemove)
                                    }
                                    TextField(L10n.connectionAddress, text: $address.baseUrl)
                                        .textFieldStyle(.roundedBorder)
                                        .onChange(of: address.baseUrl) { checks[address.id] = nil }
                                    HStack(spacing: 10) {
                                        Button(L10n.connectionCheck) {
                                            let id = address.id, origin = address.baseUrl
                                            checkingID = id; checks[id] = nil
                                            Task {
                                                do { let valid = try HostConnectionAddress(id: id, kind: address.kind, baseUrl: origin).validated(); try await verify(valid.baseUrl); checks[id] = L10n.connectionChecked }
                                                catch { checks[id] = error.localizedDescription }
                                                checkingID = nil
                                            }
                                        }.buttonStyle(FloatingGlassButtonStyle())
                                        if checkingID == address.id { ProgressView().controlSize(.small) }
                                        if let message = checks[address.id] {
                                            Text(message).font(.system(size: 11)).foregroundStyle(HostPalette.secondaryInk)
                                        }
                                    }
                                }
                                .padding(16)
                                .background(Color.white.opacity(0.3), in: RoundedRectangle(cornerRadius: 18))
                            }
                            Button {
                                addresses.append(HostConnectionAddress(id: UUID().uuidString, kind: "tailscale", baseUrl: ""))
                            } label: { Label(L10n.connectionAdd, systemImage: "plus") }
                                .buttonStyle(FloatingGlassButtonStyle())
                            Text(L10n.connectionNote).font(.system(size: 11))
                                .foregroundStyle(HostPalette.secondaryInk)
                        } else {
                            Text(L10n.connectionUpgrade).font(.system(size: 12)).foregroundStyle(HostPalette.secondaryInk)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 4)
                }
                if let errorMessage {
                    Text(errorMessage).font(.system(size: 12)).foregroundStyle(HostPalette.rose)
                }
                HStack {
                    Button(L10n.cancel, action: cancel).buttonStyle(FloatingGlassButtonStyle())
                    Spacer()
                    Button {
                        isSaving = true; errorMessage = nil
                        Task {
                            do { try await save(displayName.trimmingCharacters(in: .whitespacesAndNewlines), supportsAddresses ? try addresses.map { try $0.validated() } : nil, revision) }
                            catch { errorMessage = error.localizedDescription }
                            isSaving = false
                        }
                    } label: {
                        HStack { if isSaving { ProgressView().controlSize(.small) }; Text(L10n.saveSettings) }
                    }.buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.28)))
                    .disabled(displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || addresses.contains { $0.baseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
                }
            }
            .disabled(isSaving || checkingID != nil)
            .padding(28)
            .background {
                RoundedRectangle(cornerRadius: 30).fill(Color.white.opacity(0.27))
                    .glassEffect(.regular.tint(Color.white.opacity(0.12)), in: RoundedRectangle(cornerRadius: 30))
            }.padding(18)
        }.foregroundStyle(HostPalette.ink)
        .frame(width: 620, height: 700).preferredColorScheme(.light)
    }
}

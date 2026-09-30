import Foundation

@MainActor
enum HostMCPCatalogLoader {
    static func load(dataRequest: (String, String, Data?, Bool, [String: String]) async throws -> (Data, HTTPURLResponse)) async throws -> MCPGatewaySnapshot {
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
            "POST",
            initializeBody,
            true,
            ["Accept": "application/json, text/event-stream"]
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
            "POST",
            toolsBody,
            true,
            [
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

}

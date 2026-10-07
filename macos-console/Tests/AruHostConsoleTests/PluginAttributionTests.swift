import Foundation
import Testing
@testable import AruHostConsole

@Test func sourcePluginCreditSurvivesConsoleTransport() throws {
    let old = Data(#"{"schema":"aru.selfhost.plugin-source.v1","pluginId":"sample","displayName":"Sample","version":"1.0","sourceCode":"export const tools = [];","capabilities":[],"digest":"sha256:sample","tools":[]}"#.utf8)
    let source = try JSONDecoder().decode(HostPluginSource.self, from: old)
    #expect(source.publisher == nil)
    var object = try #require(JSONSerialization.jsonObject(with: old) as? [String: Any])
    object["publisher"] = "Example Studio"
    let credited = try JSONDecoder().decode(HostPluginSource.self, from: JSONSerialization.data(withJSONObject: object))
    #expect(credited.publisher == "Example Studio")
    let mutation = HostPluginSourceMutation(pluginId: credited.pluginId, displayName: credited.displayName,
        publisher: credited.publisher, version: credited.version, sourceCode: credited.sourceCode, capabilities: credited.capabilities)
    let encoded = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(mutation)) as? [String: Any])
    #expect(encoded["publisher"] as? String == "Example Studio")
}

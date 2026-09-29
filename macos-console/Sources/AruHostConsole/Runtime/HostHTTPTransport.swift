import Foundation

struct HostHTTPTransport {
    let session: URLSession

    func request(_ path: String, baseURL: URL, method: String, body: Data?,
                 credential: String?, headers: [String: String]) async throws -> (Data, HTTPURLResponse) {
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
        if let credential {
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
}

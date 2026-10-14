import Foundation

enum HTTPMethod: String, Sendable { case get = "GET", post = "POST" }

enum APIError: LocalizedError, Sendable {
    case invalidConfiguration
    case missingToken
    case transport
    case invalidResponse(status: Int?)
    case decoding
    case server(status: Int, code: String)

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration: return "Проверьте адрес API в настройках проекта."
        case .missingToken: return "Войдите в аккаунт."
        case .transport: return "Не удалось подключиться. Проверьте соединение."
        case .invalidResponse, .decoding: return "Не удалось прочитать ответ сервера."
        case let .server(status, code):
            switch code {
            case "invalid_credentials": return "Неверный никнейм или пароль."
            case "account_not_approved": return "Аккаунт ожидает одобрения."
            case "account_rejected": return "Заявка на регистрацию отклонена."
            case "phone_not_verified": return "Сначала подтвердите номер телефона в вебе."
            case "rate_limit_exceeded": return "Слишком много попыток. Попробуйте позже."
            case "session_revoked", "token_expired", "missing_token", "invalid_token", "user_not_found":
                return "Сессия закончилась. Войдите снова."
            default: return "Не удалось выполнить запрос (HTTP \(status))."
            }
        }
    }
}

private struct StatusEnvelope: Decodable {
    let ok: Bool
    let error: String?
}

// The actor owns credentials and request/decoder creation. No bearer token is
// published to SwiftUI, UserDefaults, files, URLs or logs.
actor APIClient {
    private let baseURL: URL
    private let session: URLSession
    private let tokenStore: KeychainTokenStore

    init(baseURL: URL, session: URLSession = URLSession(configuration: .ephemeral), tokenStore: KeychainTokenStore) {
        self.baseURL = baseURL
        self.session = session
        self.tokenStore = tokenStore
    }

    func hasStoredToken() throws -> Bool { try tokenStore.load() != nil }

    func send<Response: Decodable & Sendable>(
        _ endpoint: String, method: HTTPMethod = .get,
        query: [String: String] = [:], authenticated: Bool = true
    ) async throws -> Response {
        try await perform(endpoint, method: method, body: nil, query: query, authenticated: authenticated)
    }

    func send<Response: Decodable & Sendable, Body: Encodable & Sendable>(
        _ endpoint: String, method: HTTPMethod = .post, body: Body,
        query: [String: String] = [:], authenticated: Bool = true
    ) async throws -> Response {
        let data = try JSONEncoder().encode(body)
        return try await perform(endpoint, method: method, body: data, query: query, authenticated: authenticated)
    }

    func login(nickname: String, password: String) async throws -> LoginResponse {
        let result: LoginResponse = try await send("login", body: LoginRequest(nickname: nickname, password: password), authenticated: false)
        guard !result.token.isEmpty else { throw APIError.invalidResponse(status: 200) }
        try tokenStore.save(result.token)
        return result
    }

    func me() async throws -> MeResponse { try await send("me") }

    // Local credentials are cleared even if the network revocation fails.
    // A failure is surfaced: the server session may remain live until expiry.
    func logout() async throws {
        let loggingOutToken = try tokenStore.load()
        var requestError: Error?
        do {
            let _: OKResponse = try await send("logout", body: EmptyRequest())
        } catch { requestError = error }
        // A new login can complete while this request is in flight.
        if try tokenStore.load() == loggingOutToken { try tokenStore.clear() }
        if let requestError { throw requestError }
    }

    private func perform<Response: Decodable & Sendable>(
        _ endpoint: String, method: HTTPMethod, body: Data?,
        query: [String: String], authenticated: Bool
    ) async throws -> Response {
        guard !endpoint.isEmpty, !endpoint.contains("/"), !endpoint.contains("?"), !endpoint.contains("#"),
              endpoint != ".", endpoint != "..",
              var components = URLComponents(url: baseURL.appendingPathComponent(endpoint), resolvingAgainstBaseURL: false) else {
            throw APIError.invalidConfiguration
        }
        if !query.isEmpty {
            components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { throw APIError.invalidConfiguration }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpMethod = method.rawValue
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let sentToken: String?
        if authenticated { sentToken = try tokenStore.load() } else { sentToken = nil }
        if authenticated {
            guard let sentToken, !sentToken.isEmpty else { throw APIError.missingToken }
            request.setValue("Bearer \(sentToken)", forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch is CancellationError { throw CancellationError() }
        catch let error as URLError where error.code == .cancelled { throw CancellationError() }
        catch { throw APIError.transport }
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse(status: nil) }
        // A late 401 for an older request must not erase a newer login token.
        if http.statusCode == 401, authenticated, let sentToken,
           try tokenStore.load() == sentToken { try tokenStore.clear() }
        guard let envelope = try? JSONDecoder().decode(StatusEnvelope.self, from: data) else {
            throw APIError.invalidResponse(status: http.statusCode)
        }
        guard (200..<300).contains(http.statusCode), envelope.ok else {
            throw APIError.server(status: http.statusCode, code: envelope.error ?? "http_error")
        }
        do { return try Self.makeDecoder().decode(Response.self, from: data) }
        catch { throw APIError.decoding }
    }

    private static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            // Fresh formatters avoid sharing mutable state across concurrent decodes.
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
            guard let date = fractional.date(from: text) ?? plain.date(from: text) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid ISO 8601 timestamp"))
            }
            return date
        }
        return decoder
    }
}

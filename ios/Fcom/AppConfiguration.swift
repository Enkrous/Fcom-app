import Foundation

enum AppConfiguration {
    static func functionsBaseURL(bundle: Bundle = .main) throws -> URL {
        guard let value = bundle.object(forInfoDictionaryKey: "SupabaseFunctionsBASEURL") as? String,
              let url = URL(string: value),
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.host?.isEmpty == false,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.hasSuffix("/functions/v1") else {
            throw APIError.invalidConfiguration
        }
        return url
    }
}

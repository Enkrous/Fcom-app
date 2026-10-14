import Foundation

// Strings preserve unknown enum values and the server's opaque UUID contract.
// Optional metadata is absent in login/register and in older deployments.
struct UserDTO: Decodable, Identifiable, Sendable {
    let id: String
    let fullName: String
    let school: String
    let grade: String
    let nickname: String
    let phone: String?
    let phoneVerified: Bool
    let role: String
    let status: String
    let cred: Double
    let createdAt: Date
    let avatarUrl: String?
    let credLevel: CredLevelDTO?
    let credProgress: Double?
    let canRate: CanRateDTO?
}

struct CredLevelDTO: Decodable, Sendable {
    let name: String
    let min: Double
    let max: Double?
    let css: String
}

struct CanRateDTO: Decodable, Sendable {
    let ok: Bool
    let reason: String?
}

struct MessageDTO: Decodable, Identifiable, Sendable {
    let id: String
    let fromId: String
    let toId: String?
    let groupId: String?
    let type: String
    let text: String
    let time: Date
    let readAt: Date?
    let attachmentPath: String?
    let attachmentMime: String?
    let attachmentBytes: Int?
    let attachmentWidth: Int?
    let attachmentHeight: Int?
    let attachmentUrl: String?
    let senderDeleted: Bool?
    var isSenderDeleted: Bool { senderDeleted ?? false }
}

struct LoginRequest: Encodable, Sendable {
    let nickname: String
    let password: String
}

struct RegisterRequest: Encodable, Sendable {
    let fullName: String
    let school: String
    let grade: String
    let nickname: String
    let phone: String?
    let deviceFingerprint: String?
}

struct SetPasswordRequest: Encodable, Sendable { let password: String }
struct EmptyRequest: Encodable, Sendable {}
struct OKResponse: Decodable, Sendable { let ok: Bool }
struct LoginResponse: Decodable, Sendable {
    let ok: Bool
    let token: String
    let user: UserDTO
}
struct RegisterResponse: Decodable, Sendable {
    let ok: Bool
    let token: String?
    let user: UserDTO
    let _devOtp: String?
}
struct MeResponse: Decodable, Sendable {
    let ok: Bool
    let user: UserDTO
    let canApprove: Bool
}
struct UsersResponse: Decodable, Sendable {
    let ok: Bool
    let users: [UserDTO]
    let pending: [UserDTO]
    let usersToRate: [UserDTO]?
}
struct MessagesResponse: Decodable, Sendable {
    let ok: Bool
    let messages: [MessageDTO]
    let markedRead: Int
    let hasMore: Bool
}
struct MessageResponse: Decodable, Sendable {
    let ok: Bool
    let message: MessageDTO
}
struct SendMessageRequest: Encodable, Sendable {
    let toId: String?
    let groupId: String?
    let text: String
}

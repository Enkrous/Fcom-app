// Keep the original string sender id for clients after deleting the account.
// The tombstone contains no profile data and is never an authenticated user.
export function serializeMessageSender(message: Record<string, unknown>): Record<string, unknown> {
  const { deletedFromId, ...publicMessage } = message;
  return {
    ...publicMessage,
    fromId: message.fromId ?? deletedFromId,
    senderDeleted: message.fromId == null && deletedFromId != null,
  };
}

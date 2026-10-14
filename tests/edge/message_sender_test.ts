import { serializeMessageSender } from '../../supabase/functions/_shared/message_sender.ts';

Deno.test('deleted group author keeps a string sender id without exposing internal column', () => {
  const serialized = serializeMessageSender({ id: 'message', fromId: null, deletedFromId: 'old-user', text: 'history' });
  if (serialized.fromId !== 'old-user' || serialized.senderDeleted !== true || 'deletedFromId' in serialized) {
    throw new Error('deleted author contract changed');
  }
  const live = serializeMessageSender({ fromId: 'live-user', deletedFromId: null });
  if (live.fromId !== 'live-user' || live.senderDeleted !== false) throw new Error('live sender contract changed');
});

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3';

export type CredLevel = {
  name: string;
  min: number;
  max: number | null;
  css: 'novice' | 'known' | 'trusted' | 'own';
};

const LEVELS: CredLevel[] = [
  { name: 'Новичок', min: 0, max: 4, css: 'novice' },
  { name: 'Знакомый', min: 5, max: 14, css: 'known' },
  { name: 'Доверенный', min: 15, max: 29, css: 'trusted' },
  { name: 'Свой', min: 30, max: null, css: 'own' },
];

export function getCredLevel(cred: number): CredLevel {
  const value = Math.max(0, Number(cred) || 0);
  // Ratings produce fractional values; levels change at 5, 15 and 30.
  return { ...LEVELS[value >= 30 ? 3 : value >= 15 ? 2 : value >= 5 ? 1 : 0] };
}

export function getCredProgress(cred: number): number {
  const value = Math.max(0, Number(cred) || 0);
  return value >= 30 ? 1 : value / 40;
}

export function withCredo<T extends { cred?: number | null }>(user: T) {
  const cred = Number(user.cred) || 0;
  return { ...user, credLevel: getCredLevel(cred), credProgress: getCredProgress(cred) };
}

export type RatingContext = {
  blockedPeerIds: Set<string>;
  conversationPartnerIds: Set<string>;
  recentlyRatedIds: Set<string>;
};

export type CanRate =
  | { ok: true }
  | { ok: false; reason: 'self' | 'user_blocked' | 'no_chat' | '24h_limit' };

// Status and school access are checked by the caller before this rule runs.
export function canRate(fromId: string, toId: string, context: RatingContext): CanRate {
  if (fromId === toId) return { ok: false, reason: 'self' };
  if (context.blockedPeerIds.has(toId)) return { ok: false, reason: 'user_blocked' };
  if (!context.conversationPartnerIds.has(toId)) return { ok: false, reason: 'no_chat' };
  if (context.recentlyRatedIds.has(toId)) return { ok: false, reason: '24h_limit' };
  return { ok: true };
}

type PageResult<T> = { data: T[] | null; error: unknown };
const PAGE_SIZE = 500;

// Supabase limits each response to max_rows. Every page needs a stable unique
// order; otherwise older conversations/ratings can silently disappear here.
export async function readAllRows<T>(
  queryPage: (start: number, end: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await queryPage(start, start + PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

export async function loadRatingContext(
  supabase: SupabaseClient,
  userId: string,
  now = Date.now(),
): Promise<RatingContext> {
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const [sent, received, ratings, outgoingBlocks, incomingBlocks] = await Promise.all([
    readAllRows<{ toId: string | null }>((start, end) => supabase.from('messages')
      .select('"toId"').eq('fromId', userId).is('groupId', null)
      .order('id').range(start, end)),
    readAllRows<{ fromId: string | null }>((start, end) => supabase.from('messages')
      .select('"fromId"').eq('toId', userId).is('groupId', null)
      .order('id').range(start, end)),
    readAllRows<{ to: string }>((start, end) => supabase.from('rate_log')
      .select('"to"').eq('from', userId).gt('date', dayAgo)
      .order('id').range(start, end)),
    readAllRows<{ blockedId: string }>((start, end) => supabase.from('user_blocks')
      .select('"blockedId"').eq('blockerId', userId)
      .order('blockedId').range(start, end)),
    readAllRows<{ blockerId: string }>((start, end) => supabase.from('user_blocks')
      .select('"blockerId"').eq('blockedId', userId)
      .order('blockerId').range(start, end)),
  ]);

  return {
    blockedPeerIds: new Set([
      ...outgoingBlocks.map((block) => block.blockedId),
      ...incomingBlocks.map((block) => block.blockerId),
    ]),
    conversationPartnerIds: new Set([
      ...sent.map((message) => message.toId),
      ...received.map((message) => message.fromId),
    ].filter((id): id is string => Boolean(id))),
    recentlyRatedIds: new Set(ratings.map((rating) => rating.to)),
  };
}

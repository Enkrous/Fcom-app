/**
 * _shared/db.ts
 * Supabase client factory using service_role key.
 * Service role bypasses RLS — all authorization is handled in Edge Function logic.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export function getServiceClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

import { createClient as createSupabaseClient } from '@supabase/supabase-js'

/**
 * Supabase client for device ingestion.
 *
 * Devices have no session, so this client reads no cookies — which is also
 * what lets it keep working inside `after()`, once the device has had its
 * answer and the request is gone. Same anon key and RLS policies as the
 * cookie-based server client.
 */
export function createIngestClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}

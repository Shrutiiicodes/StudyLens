import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabaseInstance: SupabaseClient | null = null;
let serviceInstance: SupabaseClient | null = null;

/**
 * Get the client-side Supabase client (uses anon key, respects RLS).
 * Lazy initialization to avoid build-time errors when env vars are not set.
 */
export function getSupabase(): SupabaseClient {
    if (!supabaseInstance) {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

        if (!url || !key) {
            throw new Error('Supabase URL and Anon Key are required. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.');
        }

        supabaseInstance = createClient(url, key);
    }
    return supabaseInstance;
}

// Convenience alias for backwards compatibility
export const supabase = {
    from: (...args: Parameters<SupabaseClient['from']>) => getSupabase().from(...args),
    storage: { from: (...args: Parameters<SupabaseClient['storage']['from']>) => getSupabase().storage.from(...args) },
    auth: {
        getSession: () => getSupabase().auth.getSession(),
        signInWithPassword: (creds: { email: string; password: string }) => getSupabase().auth.signInWithPassword(creds),
        signUp: (creds: { email: string; password: string }) => getSupabase().auth.signUp(creds),
        signOut: () => getSupabase().auth.signOut(),
    },
};

/**
 * Get the server-side Supabase client (uses service role, bypasses RLS).
 */
export function getServiceSupabase(): SupabaseClient {
    if (!serviceInstance) {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!url || !serviceRoleKey) {
            throw new Error('Supabase URL and Service Role Key are required.');
        }

        serviceInstance = createClient(url, serviceRoleKey);
    }
    return serviceInstance;
}

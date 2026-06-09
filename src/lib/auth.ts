import { createRouteHandlerClient } from '@/lib/supabase-server';

/**
 * Resolve the authenticated user's ID from the verified session cookie.
 * Returns null if there is no valid session — callers should 401.
 * This is the ONLY trusted source of identity in API routes.
 */
export async function getAuthedUserId(): Promise<string | null> {
    const supabase = await createRouteHandlerClient();
    const { data: { user } } = await supabase.auth.getUser();
    return user?.id ?? null;
}
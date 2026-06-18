import 'server-only';
import { createServerClient as _createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;


// ── 2. Server Components ─────────────────────────────────────
/**
 * Use in async Server Components (no 'use client').
 * Drop-in for await createServerClient().
 */
export async function createServerClient() {
    const cookieStore = await cookies();

    return _createServerClient(SUPABASE_URL, SUPABASE_ANON, {
        cookies: {
            getAll() {
                return cookieStore.getAll();
            },
            setAll(cookiesToSet) {
                try {
                    cookiesToSet.forEach(({ name, value, options }) =>
                        cookieStore.set(name, value, options)
                    );
                } catch {
                    // setAll() throws in Server Components — safe to ignore
                }
            },
        },
    });
}

// ── 3. Route Handlers ────────────────────────────────────────
/**
 * Use in API route handlers (src/app/api/**\/route.ts).
 * Drop-in for createRouteHandlerClient({ cookies }).
 *
 * Example:
 *   const supabase = await createRouteHandlerClient();
 *   const { data: { user } } = await supabase.auth.getUser();
 */
export async function createRouteHandlerClient() {
    const cookieStore = await cookies();

    return _createServerClient(SUPABASE_URL, SUPABASE_ANON, {
        cookies: {
            getAll() {
                return cookieStore.getAll();
            },
            setAll(cookiesToSet) {
                try {
                    cookiesToSet.forEach(({ name, value, options }) =>
                        cookieStore.set(name, value, options)
                    );
                } catch {
                    // ignore in route handlers
                }
            },
        },
    });
}


export async function updateSession(request: NextRequest) {
    let supabaseResponse = NextResponse.next({ request });

    _createServerClient(SUPABASE_URL, SUPABASE_ANON, {
        cookies: {
            getAll() {
                return request.cookies.getAll();
            },
            setAll(cookiesToSet) {
                cookiesToSet.forEach(({ name, value }) =>
                    request.cookies.set(name, value)
                );
                supabaseResponse = NextResponse.next({ request });
                cookiesToSet.forEach(({ name, value, options }) =>
                    supabaseResponse.cookies.set(name, value, options)
                );
            },
        },
    });

    return supabaseResponse;
}
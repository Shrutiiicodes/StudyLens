/**
 * src/lib/supabase-server.ts
 *
 * Replaces the deprecated @supabase/auth-helpers-nextjs with @supabase/ssr.
 *
 * MIGRATION STEPS
 * ───────────────
 * 1. Install the new package:
 *      npm install @supabase/ssr
 *      npm uninstall @supabase/auth-helpers-nextjs
 *
 * 2. Replace ALL imports of the old helper in your code:
 *
 *    OLD (deprecated):
 *      import { createBrowserClient } from '@/lib/supabase-server';
 *      import { createServerClient } from '@/lib/supabase-server';
 *      import { createRouteHandlerClient }     from '@supabase/auth-helpers-nextjs';
 *      import { createMiddlewareClient }       from '@supabase/auth-helpers-nextjs';
 *
 *    NEW — use the helpers exported from THIS file:
 *      import { createBrowserClient }           from '@/lib/supabase-server';
 *      import { createServerClient }            from '@/lib/supabase-server';
 *      import { createRouteHandlerClient }      from '@/lib/supabase-server';
 *      import { updateSession }                 from '@/lib/supabase-server'; // for middleware
 *
 * 3. In middleware.ts, replace the body with:
 *      import { updateSession } from '@/lib/supabase-server';
 *      export async function middleware(request: NextRequest) {
 *        return await updateSession(request);
 *      }
 *
 * 4. The existing src/lib/supabase.ts (service-role client) is unchanged.
 */

import { createBrowserClient as _createBrowserClient } from '@supabase/ssr';
import { createServerClient as _createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// ── 1. Browser / Client Components ───────────────────────────
/**
 * Use in 'use client' components.
 * Drop-in for createBrowserClient().
 */
export function createBrowserClient() {
    return _createBrowserClient(SUPABASE_URL, SUPABASE_ANON);
}

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

// ── 4. Middleware ─────────────────────────────────────────────
/**
 * Call this from src/middleware.ts to keep the session token refreshed.
 *
 * src/middleware.ts:
 * ─────────────────
 *   import { NextRequest } from 'next/server';
 *   import { updateSession } from '@/lib/supabase-server';
 *
 *   export async function middleware(request: NextRequest) {
 *     return await updateSession(request);
 *   }
 *
 *   export const config = {
 *     matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
 *   };
 */
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
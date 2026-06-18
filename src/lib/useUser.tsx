'use client';

import {
    createContext,
    useContext,
    useEffect,
    useState,
    useCallback,
    type ReactNode,
} from 'react';
import type { User } from '@supabase/supabase-js';
import { createBrowserClient } from '@/lib/supabase-browser';

export interface AppUser {
    id: string;
    email: string;
    full_name: string;
    grade: number;
}

interface UserContextValue {
    user: AppUser | null;
    loading: boolean;
    signOut: () => Promise<void>;
}

const UserContext = createContext<UserContextValue>({
    user: null,
    loading: true,
    signOut: async () => { },
});

function mapUser(u: User): AppUser {
    return {
        id: u.id,
        email: u.email ?? '',
        full_name: (u.user_metadata?.full_name as string) ?? u.email?.split('@')[0] ?? 'Student',
        grade: (u.user_metadata?.grade as number) ?? 6,
    };
}

export function UserProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<AppUser | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const sb = createBrowserClient();
        let mounted = true;

        // getUser() validates against the server — the secure source of truth.
        sb.auth.getUser().then(({ data: { user: u } }) => {
            if (!mounted) return;
            setUser((prev) => (prev?.id === u?.id ? prev : (u ? mapUser(u) : null)));
            setLoading(false);
        });

        // Keep state in sync on sign-in / sign-out / token refresh, but only
        // swap the reference when the identity actually changes — prevents
        // every token refresh from re-triggering all useEffect([user]) fetches.
        const { data: { subscription } } = sb.auth.onAuthStateChange((_event, session) => {
            const next = session?.user ?? null;
            setUser((prev) => (prev?.id === next?.id ? prev : (next ? mapUser(next) : null)));
        });

        return () => {
            mounted = false;
            subscription.unsubscribe();
        };
    }, []);

    const signOut = useCallback(async () => {
        const sb = createBrowserClient();
        await sb.auth.signOut();
        setUser(null);
    }, []);

    return (
        <UserContext.Provider value={{ user, loading, signOut }}>
            {children}
        </UserContext.Provider>
    );
}

export function useUser() {
    return useContext(UserContext);
}
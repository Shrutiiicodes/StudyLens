'use client';

import { useState, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { getSupabase } from '@/lib/supabase';
import { 
  LayoutDashboard, 
  FileText, 
  Brain, 
  History, 
  Microscope, 
  Settings, 
  LogOut, 
  Menu 
} from 'lucide-react';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const [user, setUser] = useState<{ full_name: string; email: string; grade: number } | null>(null);
    const [sidebarOpen, setSidebarOpen] = useState(false);

    useEffect(() => {
        const stored = localStorage.getItem('study-lens-user');
        if (!stored) {
            router.push('/login');
            return;
        }
        const parsed = JSON.parse(stored);
        setUser(parsed);

        // Demo users don't need Supabase session management
        if (parsed.id === '00000000-0000-0000-0000-000000000001') {
            return;
        }

        // Listen for auth state changes to keep session alive
        const sb = getSupabase();
        const { data: { subscription } } = sb.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_OUT' || !session) {
                localStorage.removeItem('study-lens-user');
                router.push('/login');
            } else if (event === 'TOKEN_REFRESHED' && session) {
                // Update localStorage with refreshed user data
                const current = localStorage.getItem('study-lens-user');
                if (current) {
                    const p = JSON.parse(current);
                    p.id = session.user.id;
                    localStorage.setItem('study-lens-user', JSON.stringify(p));
                }
            }
        });

        // Listen for local profile updates
        const handleSync = () => {
            const current = localStorage.getItem('study-lens-user');
            if (current) setUser(JSON.parse(current));
        };
        window.addEventListener('storage', handleSync);

        return () => {
            subscription.unsubscribe();
            window.removeEventListener('storage', handleSync);
        };
    }, [router]);

    const handleLogout = async () => {
        const sb = getSupabase();
        await sb.auth.signOut();
        localStorage.removeItem('study-lens-user');
        router.push('/');
    };

    const navItems = [
        { href: '/dashboard', icon: <LayoutDashboard size={20} />, label: 'Dashboard' },
        { href: '/dashboard/upload', icon: <FileText size={20} />, label: 'Upload' },
        { href: '/dashboard/concepts', icon: <Brain size={20} />, label: 'Learning' },
        { href: '/dashboard/history', icon: <History size={20} />, label: 'History' },
    ];

    if (!user) {
        return (
            <div style={{
                minHeight: '100vh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--bg-primary)',
            }}>
                <div className="skeleton" style={{ width: '200px', height: '20px' }} />
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', minHeight: '100vh' }}>
            {/* Sidebar Overlay */}
            {sidebarOpen && (
                <div
                    onClick={() => setSidebarOpen(false)}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0,0,0,0.5)',
                        zIndex: 39,
                        display: 'none',
                    }}
                />
            )}

            {/* Sidebar */}
            <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
                <div style={{ padding: '24px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
                    <Link href="/dashboard" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{
                            width: '36px',
                            height: '36px',
                            borderRadius: '10px',
                            background: 'var(--gradient-primary)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}>
                            <Microscope size={20} color="white" />
                        </div>
                        <span style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                            <span className="gradient-text">Study</span> Lens
                        </span>
                    </Link>
                </div>

                <nav style={{ padding: '16px 12px', flex: 1 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {navItems.map((item) => (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={`sidebar-link ${pathname === item.href ? 'active' : ''}`}
                                onClick={() => setSidebarOpen(false)}
                            >
                                <span style={{ display: 'flex', alignItems: 'center' }}>
                                    {item.icon}
                                </span>
                                {item.label}
                            </Link>
                        ))}
                    </div>
                </nav>

                <Link
                    href="/dashboard/profile"
                    style={{
                        padding: '20px',
                        borderTop: '1px solid var(--border-subtle)',
                        textDecoration: 'none',
                        color: 'inherit',
                        display: 'block',
                        transition: 'background 0.2s ease',
                    }}
                    className="sidebar-user-card"
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                        <div style={{
                            width: '36px',
                            height: '36px',
                            borderRadius: '10px',
                            background: 'var(--gradient-secondary)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '16px',
                            fontWeight: 700,
                        }}>
                            {user.full_name.charAt(0).toUpperCase()}
                        </div>
                        <div style={{ flex: 1 }}>
                            <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{user.full_name}</div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Grade {user.grade}</div>
                        </div>
                        <Settings size={14} style={{ opacity: 0.5 }} />
                    </div>
                </Link>
                <div style={{ padding: '0 20px 20px' }}>
                    <button
                        className="btn-ghost"
                        onClick={handleLogout}
                        style={{ width: '100%', textAlign: 'left', fontSize: '0.85rem', color: 'var(--accent-danger)', padding: '0', display: 'flex', alignItems: 'center', gap: '8px' }}
                    >
                        <LogOut size={16} /> Sign Out
                    </button>
                </div>
            </aside>

            {/* Main Content */}
            <main style={{
                flex: 1,
                marginLeft: '280px',
                padding: '32px',
                minHeight: '100vh',
                background: 'var(--bg-primary)',
            }}>
                {/* Mobile header */}
                <div style={{
                    display: 'none',
                    marginBottom: '24px',
                }}>
                    <button className="btn-ghost" onClick={() => setSidebarOpen(!sidebarOpen)} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <Menu size={20} /> Menu
                    </button>
                </div>

                {children}
            </main>
        </div>
    );
}

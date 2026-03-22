'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getSupabase } from '@/lib/supabase';
import { Microscope, Rocket } from 'lucide-react';

export default function LoginPage() {
    const router = useRouter();
    const [isLogin, setIsLogin] = useState(true);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [grade, setGrade] = useState(6);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    // Auto-redirect if already logged in
    useEffect(() => {
        const stored = localStorage.getItem('study-lens-user');
        if (stored) {
            const parsed = JSON.parse(stored);
            // Demo users bypass Supabase session check
            if (parsed.id === '00000000-0000-0000-0000-000000000001') {
                router.push('/dashboard');
                return;
            }
            // Verify the Supabase session is still valid
            const sb = getSupabase();
            sb.auth.getSession().then(({ data: { session } }) => {
                if (session) {
                    router.push('/dashboard');
                } else {
                    // Session expired, clear stale localStorage
                    localStorage.removeItem('study-lens-user');
                }
            });
        }
    }, [router]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            if (!email || !password) {
                setError('Please fill in all fields');
                setLoading(false);
                return;
            }

            if (!isLogin && !name) {
                setError('Please enter your name');
                setLoading(false);
                return;
            }

            const sb = getSupabase();

            if (isLogin) {
                // Sign in with Supabase
                const { data, error: authError } = await sb.auth.signInWithPassword({
                    email,
                    password,
                });

                if (authError) {
                    setError(authError.message);
                    setLoading(false);
                    return;
                }

                // Get user metadata or fallback
                const userData = {
                    id: data.user.id,
                    email: data.user.email,
                    full_name: data.user.user_metadata?.full_name || email.split('@')[0],
                    grade: data.user.user_metadata?.grade || 6,
                };

                localStorage.setItem('study-lens-user', JSON.stringify(userData));
            } else {
                // Sign up with Supabase
                const { data, error: authError } = await sb.auth.signUp({
                    email,
                    password,
                    options: {
                        data: {
                            full_name: name,
                            grade,
                        },
                    },
                });

                if (authError) {
                    setError(authError.message);
                    setLoading(false);
                    return;
                }

                if (!data.user) {
                    setError('Sign up failed. Please try again.');
                    setLoading(false);
                    return;
                }

                const userData = {
                    id: data.user.id,
                    email: data.user.email,
                    full_name: name,
                    grade,
                };

                localStorage.setItem('study-lens-user', JSON.stringify(userData));
            }

            router.push('/dashboard');
        } catch {
            setError('Authentication failed. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    if (!mounted) return null;

    return (
        <div className="bg-grid" style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
            position: 'relative',
        }}>
            {/* Background Effects */}
            <div style={{
                position: 'absolute',
                width: '500px',
                height: '500px',
                borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(108, 92, 231, 0.12) 0%, transparent 70%)',
                top: '10%',
                left: '20%',
                pointerEvents: 'none',
            }} />
            <div style={{
                position: 'absolute',
                width: '400px',
                height: '400px',
                borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(6, 182, 212, 0.08) 0%, transparent 70%)',
                bottom: '10%',
                right: '20%',
                pointerEvents: 'none',
            }} />

            <div className="animate-fade-in" style={{ width: '100%', maxWidth: '440px', position: 'relative', zIndex: 1 }}>
                {/* Logo */}
                <Link href="/" style={{ textDecoration: 'none', display: 'flex', justifyContent: 'center', marginBottom: '40px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div style={{
                            width: '48px',
                            height: '48px',
                            borderRadius: '14px',
                            background: 'var(--gradient-primary)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '24px',
                        }}>
                            <Microscope size={24} color="white" />
                        </div>
                        <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                            <span className="gradient-text">Study</span> Lens
                        </span>
                    </div>
                </Link>

                {/* Auth Card */}
                <div className="glass-card" style={{ padding: '40px' }}>
                    <div style={{ textAlign: 'center', marginBottom: '32px' }}>
                        <h1 style={{ fontSize: '1.6rem', fontWeight: 700, marginBottom: '8px' }}>
                            {isLogin ? 'Welcome Back' : 'Create Account'}
                        </h1>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
                            {isLogin ? 'Sign in to continue your journey' : 'Start your learning journey today'}
                        </p>
                    </div>

                    {error && (
                        <div style={{
                            padding: '12px 16px',
                            borderRadius: 'var(--radius-md)',
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.3)',
                            color: 'var(--accent-danger)',
                            fontSize: '0.9rem',
                            marginBottom: '20px',
                        }}>
                            {error}
                        </div>
                    )}

                    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        {!isLogin && (
                            <div>
                                <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.9rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                                    Full Name
                                </label>
                                <input
                                    type="text"
                                    className="input-field"
                                    placeholder="Enter your name"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                />
                            </div>
                        )}

                        <div>
                            <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.9rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                                Email
                            </label>
                            <input
                                type="email"
                                className="input-field"
                                placeholder="you@example.com"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                            />
                        </div>

                        <div>
                            <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.9rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                                Password
                            </label>
                            <input
                                type="password"
                                className="input-field"
                                placeholder="••••••••"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                            />
                        </div>

                        {!isLogin && (
                            <div>
                                <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.9rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                                    Grade Level
                                </label>
                                <select
                                    className="input-field"
                                    value={grade}
                                    onChange={(e) => setGrade(Number(e.target.value))}
                                    style={{ cursor: 'pointer' }}
                                >
                                    {[4, 5, 6, 7, 8, 9, 10].map((g) => (
                                        <option key={g} value={g} style={{ background: 'var(--bg-elevated)' }}>
                                            Grade {g}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        <button
                            type="submit"
                            className="btn-primary"
                            disabled={loading}
                            style={{
                                width: '100%',
                                justifyContent: 'center',
                                padding: '14px',
                                fontSize: '1rem',
                                marginTop: '8px',
                                opacity: loading ? 0.7 : 1,
                            }}
                        >
                            {loading ? (
                                <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin-slow 1s linear infinite' }}>
                                        <path d="M21 12a9 9 0 11-6.219-8.56" />
                                    </svg>
                                    {isLogin ? 'Signing In...' : 'Creating Account...'}
                                </span>
                            ) : (
                                isLogin ? 'Sign In' : 'Create Account'
                            )}
                        </button>
                    </form>

                    {/* Divider */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '16px',
                        margin: '24px 0',
                    }}>
                        <div style={{ flex: 1, height: '1px', background: 'var(--border-subtle)' }} />
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>or</span>
                        <div style={{ flex: 1, height: '1px', background: 'var(--border-subtle)' }} />
                    </div>

                    {/* Demo Bypass */}
                    <button
                        className="btn-secondary"
                        onClick={() => {
                            const demoUser = {
                                id: '00000000-0000-0000-0000-000000000001',
                                email: 'demo@studylens.com',
                                full_name: 'Demo Student',
                                grade: 7,
                            };
                            localStorage.setItem('study-lens-user', JSON.stringify(demoUser));
                            router.push('/dashboard');
                        }}
                        style={{
                            width: '100%',
                            justifyContent: 'center',
                            padding: '14px',
                            fontSize: '0.95rem',
                        }}
                    >
                        <Rocket size={18} /> Continue as Demo Student
                    </button>

                    <div style={{ textAlign: 'center', marginTop: '20px' }}>
                        <button
                            className="btn-ghost"
                            onClick={() => { setIsLogin(!isLogin); setError(''); }}
                            style={{ fontSize: '0.9rem' }}
                        >
                            {isLogin ? "Don't have an account? " : 'Already have an account? '}
                            <span style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>
                                {isLogin ? 'Sign Up' : 'Sign In'}
                            </span>
                        </button>
                    </div>
                </div>

                <p style={{
                    textAlign: 'center',
                    marginTop: '24px',
                    color: 'var(--text-muted)',
                    fontSize: '0.8rem',
                }}>
                    Use demo mode for quick access, or sign up for a persistent account
                </p>
            </div>
        </div>
    );
}

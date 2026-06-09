'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@/lib/supabase-browser';
import { useUser } from '@/lib/useUser';
import { CheckCircle, XCircle, LogOut } from 'lucide-react';

export default function ProfilePage() {
    const router = useRouter();
    const { user, signOut } = useUser();
    const [name, setName] = useState('');
    const [grade, setGrade] = useState(6);
    const [contact, setContact] = useState('');
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState({ text: '', type: '' });

    useEffect(() => {
        if (!user) return;
        setName(user.full_name || '');
        setGrade(user.grade || 6);
        setContact(user.email || '');
    }, [user]);

    const handleUpdate = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setMessage({ text: '', type: '' });

        try {
            if (!user) return;

            const sb = createBrowserClient();
            const { error } = await sb.auth.updateUser({
                data: {
                    full_name: name,
                    grade: grade,
                }
            });

            if (error) throw error;

            setMessage({ text: 'Profile updated successfully!', type: 'success' });
        } catch (err) {
            console.error('Update failed:', err);
            setMessage({ text: (err as any).message || 'Failed to update profile', type: 'error' });
        } finally {
            setLoading(false);
        }
    };

    const handleLogout = async () => {
        await signOut();
        router.push('/');
    };

    if (!user) return null;

    return (
        <div className="animate-fade-in" style={{ maxWidth: '600px' }}>
            <div style={{ marginBottom: '32px' }}>
                <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '8px' }}>
                    Your Profile
                </h1>
                <p style={{ color: 'var(--text-secondary)', fontSize: '1rem' }}>
                    Manage your account settings and preferences
                </p>
            </div>

            {message.text && (
                <div style={{
                    padding: '12px 16px',
                    borderRadius: 'var(--radius-md)',
                    background: message.type === 'success' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                    border: message.type === 'success' ? '1px solid rgba(34, 197, 94, 0.3)' : '1px solid rgba(239, 68, 68, 0.3)',
                    color: message.type === 'success' ? 'var(--accent-success)' : 'var(--accent-danger)',
                    fontSize: '0.9rem',
                    marginBottom: '24px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                }}>
                    {message.type === 'success' ? <CheckCircle size={18} /> : <XCircle size={18} />} {message.text}
                </div>
            )}

            <div className="glass-card" style={{ padding: '32px' }}>
                <form onSubmit={handleUpdate} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    <div>
                        <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                            Full Name
                        </label>
                        <input
                            type="text"
                            className="input-field"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Enter your name"
                            required
                        />
                    </div>

                    <div>
                        <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
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

                    <div>
                        <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                            Contact Info (Email)
                        </label>
                        <input
                            type="email"
                            className="input-field"
                            value={contact}
                            disabled
                            style={{ opacity: 0.7, cursor: 'not-allowed' }}
                            title="Email cannot be changed directly"
                        />
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                            Email changes are currently restricted for security.
                        </p>
                    </div>

                    <div style={{ marginTop: '12px', display: 'flex', gap: '12px' }}>
                        <button
                            type="submit"
                            className="btn-primary"
                            disabled={loading}
                            style={{ flex: 1, justifyContent: 'center' }}
                        >
                            {loading ? 'Saving Changes...' : 'Save Changes'}
                        </button>
                    </div>
                </form>

                <div style={{
                    marginTop: '40px',
                    paddingTop: '24px',
                    borderTop: '1px solid var(--border-subtle)',
                }}>
                    <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '16px', color: 'var(--accent-danger)' }}>
                        Danger Zone
                    </h3>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '20px' }}>
                        Sign out of your account to end your current session.
                    </p>
                    <button
                        onClick={handleLogout}
                        className="btn-secondary"
                        style={{
                            borderColor: 'rgba(239, 68, 68, 0.3)',
                            color: 'var(--accent-danger)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                        }}
                    >
                        <LogOut size={18} /> Sign Out
                    </button>
                </div>
            </div>
        </div>
    );
}
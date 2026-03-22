'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabase } from '@/lib/supabase';
import { CheckCircle, XCircle, LogOut } from 'lucide-react';

interface UserData {
    id: string;
    email: string;
    full_name: string;
    grade: number;
    phone?: string;
}

export default function ProfilePage() {
    const router = useRouter();
    const [user, setUser] = useState<UserData | null>(null);
    const [name, setName] = useState('');
    const [grade, setGrade] = useState(6);
    const [contact, setContact] = useState('');
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState({ text: '', type: '' });

    useEffect(() => {
        const stored = localStorage.getItem('study-lens-user');
        if (stored) {
            const parsed = JSON.parse(stored);
            setUser(parsed);
            setName(parsed.full_name || '');
            setGrade(parsed.grade || 6);
            setContact(parsed.email || '');
        }
    }, []);

    const handleUpdate = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setMessage({ text: '', type: '' });

        try {
            if (!user) return;

            const updatedUser = {
                ...user,
                full_name: name,
                grade: grade,
            };

            // If not a demo user, update Supabase
            if (user.id !== '00000000-0000-0000-0000-000000000001') {
                const sb = getSupabase();
                const { error } = await sb.auth.updateUser({
                    data: {
                        full_name: name,
                        grade: grade,
                    }
                });

                if (error) throw error;
            }

            // Update localStorage
            localStorage.setItem('study-lens-user', JSON.stringify(updatedUser));
            setUser(updatedUser);
            setMessage({ text: 'Profile updated successfully!', type: 'success' });

            // Trigger a layout re-render if needed (layout reads from localStorage)
            window.dispatchEvent(new Event('storage'));
        } catch (err) {
            console.error('Update failed:', err);
            setMessage({ text: (err as any).message || 'Failed to update profile', type: 'error' });
        } finally {
            setLoading(false);
        }
    };

    const handleLogout = async () => {
        const sb = getSupabase();
        await sb.auth.signOut();
        localStorage.removeItem('study-lens-user');
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

            {user.id === '00000000-0000-0000-0000-000000000001' && (
                <p style={{
                    marginTop: '24px',
                    color: 'var(--text-muted)',
                    fontSize: '0.85rem',
                    textAlign: 'center',
                    fontStyle: 'italic'
                }}>
                    Note: You are in Demo Mode. Changes are saved locally to your browser.
                </p>
            )}
        </div>
    );
}

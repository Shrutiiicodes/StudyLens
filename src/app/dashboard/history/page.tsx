'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
    Search,
    FileEdit,
    Trophy,
    Clock,
    ClipboardList,
    BarChart,
    HelpCircle,
    Target,
    ChevronRight,
    TrendingUp,
    TrendingDown,
    Minus,
} from 'lucide-react';

interface SessionRecord {
    id: string;
    concept_id: string;
    concept_title: string;
    mode: string;
    score: number;
    passed: boolean;
    nlg: number | null;
    brier_score: number | null;
    created_at: string;
}

const modeIcons: Record<string, React.ElementType> = {
    diagnostic: Search,
    practice: FileEdit,
    mastery: Trophy,
};

const modeColors: Record<string, string> = {
    diagnostic: '#06b6d4',
    practice: '#6c5ce7',
    mastery: '#22c55e',
};

const modeLabels: Record<string, string> = {
    diagnostic: 'Easy 5',
    practice: 'Practice Test',
    mastery: 'Mastery Test',
};

function NLGIndicator({ nlg }: { nlg: number | null }) {
    if (nlg === null) return null;
    const pct = Math.round(nlg * 100);
    if (nlg > 0.05) return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '0.75rem', color: '#22c55e', fontWeight: 600 }}>
            <TrendingUp size={12} /> +{pct}%
        </span>
    );
    if (nlg < -0.05) return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '0.75rem', color: '#ef4444', fontWeight: 600 }}>
            <TrendingDown size={12} /> {pct}%
        </span>
    );
    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>
            <Minus size={12} /> {pct}%
        </span>
    );
}

function formatDuration(createdAt: string): string {
    const date = new Date(createdAt);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString();
}

export default function HistoryPage() {
    const router = useRouter();
    const [sessions, setSessions] = useState<SessionRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        async function fetchHistory() {
            try {
                const stored = localStorage.getItem('study-lens-user');
                if (!stored) { setLoading(false); return; }
                const user = JSON.parse(stored);

                // Fetch sessions joined with concept titles
                const res = await fetch(`/api/history?userId=${user.id}`);
                if (!res.ok) throw new Error('Failed to fetch history');
                const data = await res.json();

                if (data.success) {
                    setSessions(data.sessions);
                }
            } catch (err) {
                setError('Failed to load history.');
                console.error(err);
            } finally {
                setLoading(false);
            }
        }
        fetchHistory();
    }, []);

    // ── Computed stats ─────────────────────────────────────────────────────
    const totalTests = sessions.length;
    const avgScore = totalTests > 0
        ? Math.round(sessions.reduce((s, h) => s + h.score, 0) / totalTests)
        : 0;
    const passedCount = sessions.filter(s => s.passed).length;
    const passRate = totalTests > 0 ? Math.round((passedCount / totalTests) * 100) : 0;
    const nlgSessions = sessions.filter(s => s.nlg !== null);
    const avgNLG = nlgSessions.length > 0
        ? Math.round(nlgSessions.reduce((s, h) => s + (h.nlg ?? 0), 0) / nlgSessions.length * 100)
        : null;

    if (loading) {
        return (
            <div className="animate-fade-in">
                <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '32px' }}>Test History</h1>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {[1, 2, 3, 4].map(i => (
                        <div key={i} className="glass-card" style={{ padding: '20px 24px', height: '72px', opacity: 0.4 }} />
                    ))}
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="animate-fade-in">
                <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '32px' }}>Test History</h1>
                <div className="glass-card" style={{ padding: '40px', textAlign: 'center', color: 'var(--accent-danger)' }}>
                    {error}
                </div>
            </div>
        );
    }

    return (
        <div className="animate-fade-in">
            <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '8px' }}>Test History</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '1rem', marginBottom: '32px' }}>
                Review your past assessments and track your progress
            </p>

            {/* Summary Stats */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '16px',
                marginBottom: '32px',
            }}>
                {[
                    { label: 'Total Tests', value: totalTests, icon: <ClipboardList size={24} />, color: 'var(--accent-primary)' },
                    { label: 'Avg Score', value: `${avgScore}%`, icon: <BarChart size={24} />, color: 'var(--accent-tertiary)' },
                    { label: 'Pass Rate', value: `${passRate}%`, icon: <Target size={24} />, color: 'var(--accent-success)' },
                    { label: 'Avg Learning Gain', value: avgNLG !== null ? `+${avgNLG}%` : '—', icon: <TrendingUp size={24} />, color: '#22c55e' },
                ].map((stat, idx) => (
                    <div key={idx} className="stat-card" style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
                        <div style={{ color: stat.color, marginBottom: '8px' }}>{stat.icon}</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 700, color: stat.color }}>{stat.value}</div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>{stat.label}</div>
                    </div>
                ))}
            </div>

            {/* Session List */}
            {sessions.length === 0 ? (
                <div className="glass-card" style={{ padding: '48px', textAlign: 'center' }}>
                    <ClipboardList size={48} style={{ margin: '0 auto 16px', opacity: 0.3 }} />
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '8px' }}>No tests yet</h3>
                    <p style={{ color: 'var(--text-secondary)' }}>Complete your first assessment to see history here.</p>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {sessions.map((session) => {
                        const IconComponent = modeIcons[session.mode] ?? ClipboardList;
                        const color = modeColors[session.mode] ?? 'var(--accent-primary)';

                        return (
                            <div
                                key={session.id}
                                className="glass-card"
                                style={{
                                    padding: '20px 24px',
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    cursor: 'pointer',
                                    flexWrap: 'wrap',
                                    gap: '12px',
                                }}
                                onClick={() => router.push(`/dashboard/concept/${session.concept_id}`)}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                                    {/* Mode icon */}
                                    <div style={{
                                        width: '44px',
                                        height: '44px',
                                        borderRadius: '12px',
                                        background: `${color}18`,
                                        border: `1px solid ${color}30`,
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        color,
                                        flexShrink: 0,
                                    }}>
                                        <IconComponent size={20} />
                                    </div>

                                    {/* Concept + mode */}
                                    <div>
                                        <div style={{ fontWeight: 600, fontSize: '1rem', marginBottom: '4px' }}>
                                            {session.concept_title}
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                            <span style={{ fontSize: '0.8rem', color, fontWeight: 500 }}>
                                                {modeLabels[session.mode] ?? session.mode}
                                            </span>
                                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                <Clock size={11} /> {formatDuration(session.created_at)}
                                            </span>
                                            <NLGIndicator nlg={session.nlg} />
                                        </div>
                                    </div>
                                </div>

                                {/* Score + pass badge + chevron */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                                    <div style={{ textAlign: 'right' }}>
                                        <div style={{
                                            fontSize: '1.4rem',
                                            fontWeight: 700,
                                            color: session.score >= 85 ? 'var(--accent-success)'
                                                : session.score >= 60 ? 'var(--accent-primary)'
                                                    : 'var(--accent-warning)',
                                        }}>
                                            {session.score}%
                                        </div>
                                        <div style={{
                                            fontSize: '0.72rem',
                                            fontWeight: 600,
                                            color: session.passed ? 'var(--accent-success)' : 'var(--text-muted)',
                                        }}>
                                            {session.passed ? '✓ Passed' : 'Not passed'}
                                        </div>
                                    </div>
                                    <ChevronRight size={18} color="var(--text-muted)" />
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
    Search, FileEdit, Trophy, Clock, ClipboardList,
    BarChart, Target, ChevronRight, TrendingUp,
    TrendingDown, Minus, AlertTriangle, ChevronDown, ChevronUp,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SessionBreakdown {
    total: number;
    correct: number;
    by_difficulty: { easy: number; medium: number; hard: number };
    by_difficulty_incorrect: { easy: number; medium: number; hard: number };
    by_type: Record<string, { total: number; incorrect: number }>;
}

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
    breakdown: SessionBreakdown | null;
}

interface WeakTopic {
    concept_id: string;
    concept_title: string;
    incorrect_count: number;
    questions: Array<{ question_text: string; correct_answer: string; difficulty: number }>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const modeIcons: Record<string, React.ElementType> = {
    diagnostic: Search, practice: FileEdit, mastery: Trophy,
};
const modeColors: Record<string, string> = {
    diagnostic: '#06b6d4', practice: '#6c5ce7', mastery: '#22c55e',
};
const modeLabels: Record<string, string> = {
    diagnostic: 'Easy 5', practice: 'Practice Test', mastery: 'Mastery Test',
};
const difficultyColors = { easy: '#22c55e', medium: '#f59e0b', hard: '#ef4444' };

// ── Sub-components ────────────────────────────────────────────────────────────

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
    const diffDays = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    return new Date(createdAt).toLocaleDateString();
}

function DifficultyBar({ label, total, incorrect, color }: {
    label: string; total: number; incorrect: number; color: string;
}) {
    if (total === 0) return null;
    const pct = Math.round((incorrect / total) * 100);
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.78rem' }}>
            <span style={{ width: '40px', color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
            <div style={{ flex: 1, height: '6px', background: 'var(--bg-elevated)', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: '3px', transition: 'width 0.4s ease' }} />
            </div>
            <span style={{ width: '48px', textAlign: 'right', color: 'var(--text-muted)', flexShrink: 0 }}>
                {incorrect}/{total} wrong
            </span>
        </div>
    );
}

function SessionBreakdownPanel({ breakdown }: { breakdown: SessionBreakdown }) {
    return (
        <div style={{
            marginTop: '12px',
            padding: '16px',
            background: 'var(--bg-secondary)',
            borderRadius: 'var(--radius-sm)',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
        }}>
            {/* Difficulty breakdown */}
            <div>
                <p style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Mistakes by difficulty
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <DifficultyBar label="Easy" total={breakdown.by_difficulty.easy} incorrect={breakdown.by_difficulty_incorrect.easy} color={difficultyColors.easy} />
                    <DifficultyBar label="Med" total={breakdown.by_difficulty.medium} incorrect={breakdown.by_difficulty_incorrect.medium} color={difficultyColors.medium} />
                    <DifficultyBar label="Hard" total={breakdown.by_difficulty.hard} incorrect={breakdown.by_difficulty_incorrect.hard} color={difficultyColors.hard} />
                </div>
            </div>
        </div>
    );
}

function WeakTopicsPanel({ topics, onNavigate }: {
    topics: WeakTopic[];
    onNavigate: (conceptId: string) => void;
}) {
    const [expanded, setExpanded] = useState<string | null>(null);

    if (topics.length === 0) return null;

    return (
        <div className="glass-card" style={{ padding: '24px', marginBottom: '32px', borderLeft: '4px solid #ef4444' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
                <AlertTriangle size={20} color="#ef4444" />
                <div>
                    <h2 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>Topics to Work On</h2>
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '2px 0 0' }}>
                        Based on your incorrect answers across all tests
                    </p>
                </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {topics.map((topic) => {
                    const isOpen = expanded === topic.concept_id;
                    return (
                        <div key={topic.concept_id} style={{
                            background: 'var(--bg-secondary)',
                            borderRadius: 'var(--radius-sm)',
                            overflow: 'hidden',
                            border: '1px solid rgba(239,68,68,0.15)',
                        }}>
                            {/* Header row */}
                            <button
                                onClick={() => setExpanded(isOpen ? null : topic.concept_id)}
                                style={{
                                    width: '100%', background: 'none', border: 'none',
                                    cursor: 'pointer', padding: '12px 16px',
                                    display: 'flex', justifyContent: 'space-between',
                                    alignItems: 'center', gap: '12px', textAlign: 'left',
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1 }}>
                                    <div style={{
                                        minWidth: '28px', height: '28px', borderRadius: '6px',
                                        background: 'rgba(239,68,68,0.12)',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        fontSize: '0.75rem', fontWeight: 700, color: '#ef4444', flexShrink: 0,
                                    }}>
                                        {topic.incorrect_count}
                                    </div>
                                    <span style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                                        {topic.concept_title}
                                    </span>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); onNavigate(topic.concept_id); }}
                                        style={{
                                            fontSize: '0.75rem', fontWeight: 600,
                                            color: 'var(--accent-primary)',
                                            background: 'rgba(108,92,231,0.1)',
                                            border: '1px solid rgba(108,92,231,0.2)',
                                            borderRadius: '4px', padding: '3px 8px',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        Review
                                    </button>
                                    {isOpen
                                        ? <ChevronUp size={15} color="var(--text-muted)" />
                                        : <ChevronDown size={15} color="var(--text-muted)" />
                                    }
                                </div>
                            </button>

                            {/* Expanded: sample questions */}
                            {isOpen && topic.questions.length > 0 && (
                                <div style={{ padding: '0 16px 14px', borderTop: '1px solid rgba(239,68,68,0.1)' }}>
                                    <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '10px 0 8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                        Sample questions you missed
                                    </p>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                        {topic.questions.map((q, i) => (
                                            <div key={i} style={{
                                                padding: '10px 12px',
                                                background: 'var(--bg-elevated)',
                                                borderRadius: 'var(--radius-sm)',
                                                borderLeft: `3px solid ${q.difficulty === 1 ? difficultyColors.easy : q.difficulty === 2 ? difficultyColors.medium : difficultyColors.hard}`,
                                            }}>
                                                <p style={{ fontSize: '0.83rem', color: 'var(--text-primary)', margin: '0 0 4px', lineHeight: 1.5 }}>
                                                    {q.question_text}
                                                </p>
                                                <p style={{ fontSize: '0.75rem', color: '#22c55e', margin: 0, fontWeight: 600 }}>
                                                    ✓ {q.correct_answer}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function HistoryPage() {
    const router = useRouter();
    const [sessions, setSessions] = useState<SessionRecord[]>([]);
    const [weakTopics, setWeakTopics] = useState<WeakTopic[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [expandedSession, setExpandedSession] = useState<string | null>(null);

    useEffect(() => {
        async function fetchHistory() {
            try {
                const stored = localStorage.getItem('study-lens-user');
                if (!stored) { setLoading(false); return; }
                const user = JSON.parse(stored);

                const res = await fetch(`/api/history?userId=${user.id}`);
                if (!res.ok) throw new Error('Failed to fetch history');
                const data = await res.json();

                if (data.success) {
                    setSessions(data.sessions);
                    setWeakTopics(data.weakTopics ?? []);
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

    // ── Computed stats ────────────────────────────────────────────────────
    const totalTests = sessions.length;
    const avgScore = totalTests > 0
        ? Math.round(sessions.reduce((s, h) => s + h.score, 0) / totalTests) : 0;
    const passRate = totalTests > 0
        ? Math.round((sessions.filter(s => s.passed).length / totalTests) * 100) : 0;
    const nlgSessions = sessions.filter(s => s.nlg !== null);
    const avgNLG = nlgSessions.length > 0
        ? Math.round(nlgSessions.reduce((s, h) => s + (h.nlg ?? 0), 0) / nlgSessions.length * 100) : null;

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
                <div className="glass-card" style={{ padding: '40px', textAlign: 'center', color: 'var(--accent-danger)' }}>{error}</div>
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '32px' }}>
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

            {/* Weak Topics Panel */}
            <WeakTopicsPanel
                topics={weakTopics}
                onNavigate={(id) => router.push(`/dashboard/learn/${id}`)}
            />

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
                        const isExpanded = expandedSession === session.id;
                        const hasBreakdown = session.breakdown && session.breakdown.total > 0;

                        return (
                            <div key={session.id} className="glass-card" style={{ padding: '20px 24px' }}>
                                {/* Main row */}
                                <div
                                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', flexWrap: 'wrap', gap: '12px' }}
                                    onClick={() => hasBreakdown
                                        ? setExpandedSession(isExpanded ? null : session.id)
                                        : router.push(`/dashboard/concept/${session.concept_id}`)
                                    }
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                                        <div style={{
                                            width: '44px', height: '44px', borderRadius: '12px',
                                            background: `${color}18`, border: `1px solid ${color}30`,
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            color, flexShrink: 0,
                                        }}>
                                            <IconComponent size={20} />
                                        </div>
                                        <div>
                                            <div style={{ fontWeight: 600, fontSize: '1rem', marginBottom: '4px' }}>
                                                {session.concept_title}
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
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

                                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                                        <div style={{ textAlign: 'right' }}>
                                            <div style={{
                                                fontSize: '1.4rem', fontWeight: 700,
                                                color: session.score >= 85 ? 'var(--accent-success)'
                                                    : session.score >= 60 ? 'var(--accent-primary)'
                                                        : 'var(--accent-warning)',
                                            }}>
                                                {session.score}%
                                            </div>
                                            <div style={{ fontSize: '0.72rem', fontWeight: 600, color: session.passed ? 'var(--accent-success)' : 'var(--text-muted)' }}>
                                                {session.passed ? '✓ Passed' : 'Not passed'}
                                            </div>
                                        </div>
                                        {hasBreakdown
                                            ? isExpanded
                                                ? <ChevronUp size={18} color="var(--text-muted)" />
                                                : <ChevronDown size={18} color="var(--text-muted)" />
                                            : <ChevronRight size={18} color="var(--text-muted)" />
                                        }
                                    </div>
                                </div>

                                {/* Expandable breakdown */}
                                {isExpanded && session.breakdown && (
                                    <SessionBreakdownPanel breakdown={session.breakdown} />
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
    Search,
    FileEdit,
    Trophy,
    Clock,
    Pencil,
    FileText,
    CheckCircle,
    Book,
    Lock
} from 'lucide-react';

interface ConceptRecord {
    id: string;
    title: string;
    source_document: string;
    created_at: string;
}

interface ProgressData {
    score: number;
    stage: string;
    lastUpdated: string;
    needsReview?: boolean; // Fix 15: FSRS-triggered review indicator
}

// The 3 actionable stages students progress through.
// 'complete' is a status, not a stage button — handled separately.
const STAGES = [
    { key: 'diagnostic', label: 'Easy 5', icon: <Search size={14} />, description: 'Initial knowledge check' },
    { key: 'practice', label: 'Practice Test', icon: <FileEdit size={14} />, description: 'Adaptive practice questions' },
    { key: 'mastery', label: 'Mastery Test', icon: <Trophy size={14} />, description: 'Prove full understanding' },
];

export default function ConceptsPage() {
    const [concepts, setConcepts] = useState<ConceptRecord[]>([]);
    const [progress, setProgress] = useState<Record<string, ProgressData>>({});
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchData() {
            try {
                const stored = localStorage.getItem('study-lens-user');
                if (!stored) return;
                const user = JSON.parse(stored);

                const [conceptsRes, progressRes] = await Promise.all([
                    fetch(`/api/concepts?userId=${user.id}`),
                    fetch(`/api/progress?userId=${user.id}`),
                ]);

                const conceptsData = await conceptsRes.json();
                const progressData = await progressRes.json();

                if (conceptsData.success && conceptsData.concepts) {
                    setConcepts(conceptsData.concepts);
                }
                if (progressData.success && progressData.progress) {
                    setProgress(progressData.progress);
                }
            } catch (err) {
                console.error('Failed to fetch data:', err);
            } finally {
                setLoading(false);
            }
        }

        fetchData();
    }, []);

    function needsReview(conceptId: string): boolean {
        const p = progress[conceptId];
        if (!p?.lastUpdated) return false;
        if (p.stage === 'complete') return false;
        const hoursElapsed = (Date.now() - new Date(p.lastUpdated).getTime()) / (1000 * 60 * 60);
        return hoursElapsed > 72 && p.score > 0; // 3+ days since last activity
    }

    function getStageIndex(conceptId: string): number {
        const p = progress[conceptId];
        if (!p) return 0;
        // 'complete' means all 3 stages done — return STAGES.length so
        // all stage bars fill green and all buttons show ✓
        if (p.stage === 'complete') return STAGES.length;
        const idx = STAGES.findIndex((s) => s.key === p.stage);
        return idx >= 0 ? idx : 0;
    }

    if (loading) {
        return (
            <div className="animate-fade-in" style={{ maxWidth: '900px', margin: '0 auto' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {[1, 2, 3].map((i) => (
                        <div key={i} className="glass-card" style={{ padding: '24px', height: '160px', opacity: 0.5 }} />
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="animate-fade-in" style={{ maxWidth: '900px', margin: '0 auto' }}>
            <div style={{ marginBottom: '32px' }}>
                <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '8px' }}>
                    Your Concepts
                </h1>
                <p style={{ color: 'var(--text-secondary)', fontSize: '1rem' }}>
                    Track your progress through each concept
                </p>
            </div>

            {concepts.length === 0 ? (
                <div className="glass-card" style={{ padding: '48px', textAlign: 'center' }}>
                    <FileText size={48} style={{ margin: '0 auto 16px', opacity: 0.4 }} />
                    <h3 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '8px' }}>No concepts yet</h3>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>
                        Upload a document to get started
                    </p>
                    <Link href="/dashboard/upload" className="btn-primary" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '8px', margin: '0 auto' }}>
                        <FileText size={18} /> Upload Document
                    </Link>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    {concepts.map((concept) => {
                        const currentStageIdx = getStageIndex(concept.id);
                        const p = progress[concept.id];
                        const isComplete = p?.stage === 'complete';

                        return (
                            <div key={concept.id} className="glass-card" style={{ padding: '24px' }}>
                                {/* Concept Header */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px', gap: '12px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                                        <div>
                                            <h3 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                                                <FileText size={20} style={{ flexShrink: 0 }} />
                                                <span>{concept.title}</span>
                                                {isComplete && (
                                                    <span style={{
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        gap: '4px',
                                                        fontSize: '0.75rem',
                                                        fontWeight: 600,
                                                        color: 'var(--accent-success)',
                                                        background: 'rgba(34,197,94,0.1)',
                                                        border: '1px solid rgba(34,197,94,0.3)',
                                                        padding: '2px 8px',
                                                        borderRadius: '100px',
                                                    }}>
                                                        <CheckCircle size={12} /> Complete
                                                    </span>
                                                )}
                                            </h3>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginLeft: '28px' }}>
                                                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                                                    Uploaded {new Date(concept.created_at).toLocaleDateString()}
                                                </p>
                                                {p && !isComplete && (
                                                    <span style={{
                                                        fontSize: '0.8rem',
                                                        color: 'var(--text-muted)',
                                                        background: 'var(--bg-elevated)',
                                                        padding: '2px 8px',
                                                        borderRadius: 'var(--radius-sm)',
                                                    }}>
                                                        Score: {Math.round(p.score)}%
                                                    </span>
                                                )}
                                                {/* Fix 15: needs review badge */}
                                                {needsReview(concept.id) && (
                                                    <span style={{
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        gap: '3px',
                                                        fontSize: '0.72rem',
                                                        fontWeight: 600,
                                                        color: '#f59e0b',
                                                        background: 'rgba(245,158,11,0.1)',
                                                        border: '1px solid rgba(245,158,11,0.3)',
                                                        padding: '2px 7px',
                                                        borderRadius: '100px',
                                                    }}>
                                                        <Clock size={10} /> Review due
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <Link
                                            href={`/dashboard/learn/${concept.id}`}
                                            className="btn-secondary"
                                            style={{ textDecoration: 'none', fontSize: '0.85rem', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}
                                        >
                                            <Book size={16} /> Learn It
                                        </Link>
                                    </div>
                                </div>

                                {/* Stage Progress Bar — 3 segments */}
                                <div style={{ display: 'flex', gap: '4px', marginBottom: '16px' }}>
                                    {STAGES.map((_, idx) => (
                                        <div key={idx} style={{
                                            flex: 1,
                                            height: '4px',
                                            borderRadius: '2px',
                                            background: isComplete || idx < currentStageIdx
                                                ? 'var(--accent-success)'
                                                : idx === currentStageIdx
                                                    ? 'var(--accent-primary)'
                                                    : 'var(--bg-elevated)',
                                            transition: 'background 0.3s ease',
                                        }} />
                                    ))}
                                </div>

                                {/* Stage Buttons */}
                                <div style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                                    gap: '8px',
                                }}>
                                    {STAGES.map((stage, idx) => {
                                        const isCompleted = isComplete || idx < currentStageIdx;
                                        const isCurrent = !isComplete && idx === currentStageIdx;
                                        const isLocked = !isComplete && idx > currentStageIdx;

                                        const href = `/dashboard/test/${concept.id}?mode=${stage.key}&title=${encodeURIComponent(concept.title)}`;

                                        if (isLocked) {
                                            return (
                                                <div key={stage.key} style={{
                                                    padding: '10px 14px',
                                                    borderRadius: 'var(--radius-md)',
                                                    background: 'var(--bg-elevated)',
                                                    opacity: 0.5,
                                                    textAlign: 'center',
                                                    cursor: 'not-allowed',
                                                    fontSize: '0.85rem',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    gap: '8px',
                                                }}>
                                                    <Lock size={14} /> {stage.label}
                                                </div>
                                            );
                                        }

                                        return (
                                            <Link
                                                key={stage.key}
                                                href={href}
                                                className={isCurrent ? 'btn-primary' : 'btn-secondary'}
                                                style={{
                                                    textDecoration: 'none',
                                                    fontSize: '0.85rem',
                                                    padding: '10px 14px',
                                                    textAlign: 'center',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    gap: '8px',
                                                }}
                                            >
                                                {isCompleted ? <CheckCircle size={14} /> : stage.icon}
                                                {stage.label}
                                            </Link>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
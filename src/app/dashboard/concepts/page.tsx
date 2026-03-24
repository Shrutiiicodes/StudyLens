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
}

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

                // Fetch concepts and progress in parallel
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

    function getStageIndex(conceptId: string): number {
        const p = progress[conceptId];
        if (!p) return 0;
        const idx = STAGES.findIndex((s) => s.key === p.stage);
        return idx >= 0 ? idx : 0;
    }

    if (loading) {
        return (
            <div className="animate-fade-in">
                <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '24px' }}>Learning Journey</h1>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {[1, 2].map((i) => (
                        <div key={i} className="glass-card skeleton" style={{ height: '180px' }} />
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="animate-fade-in">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '32px', flexWrap: 'wrap', gap: '12px' }}>
                <div>
                    <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '8px' }}>
                        Learning Journey
                    </h1>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '1rem' }}>
                        {concepts.length} topic{concepts.length !== 1 ? 's' : ''} in your journey
                    </p>
                </div>
                <Link href="/dashboard/upload" className="btn-primary" style={{ textDecoration: 'none' }}>
                    + Upload New
                </Link>
            </div>

            {concepts.length === 0 ? (
                <div className="glass-card" style={{ padding: '60px 40px', textAlign: 'center' }}>
                    <div style={{ fontSize: '3rem', marginBottom: '16px', display: 'flex', justifyContent: 'center' }}>
                        <FileText size={48} color="var(--text-muted)" />
                    </div>
                    <h2 style={{ fontSize: '1.3rem', fontWeight: 600, marginBottom: '12px' }}>
                        No concepts yet
                    </h2>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>
                        Upload a PDF or DOCX document to extract concepts and start your learning journey.
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
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                                        <div>
                                            <h3 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                                                <FileText size={20} style={{ flexShrink: 0 }} /> <span>{concept.title}</span>
                                            </h3>
                                            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginLeft: '28px' }}>
                                                Uploaded {new Date(concept.created_at).toLocaleDateString()}
                                            </p>
                                        </div>
                                        <Link
                                            href={`/dashboard/learn/${concept.id}`}
                                            className="btn-secondary"
                                            style={{ textDecoration: 'none', fontSize: '0.85rem', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '8px' }}
                                        >
                                            <Book size={16} /> Learn It
                                        </Link>
                                    </div>
                                    {isComplete && (
                                        <span className="badge badge-success" style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            <CheckCircle size={14} /> Complete
                                        </span>
                                    )}
                                    {p && !isComplete && (
                                        <span style={{
                                            fontSize: '0.8rem',
                                            color: 'var(--text-muted)',
                                            background: 'var(--bg-elevated)',
                                            padding: '4px 10px',
                                            borderRadius: 'var(--radius-sm)',
                                        }}>
                                            Score: {Math.round(p.score)}%
                                        </span>
                                    )}
                                </div>

                                {/* Stage Progress Bar */}
                                <div style={{
                                    display: 'flex',
                                    gap: '4px',
                                    marginBottom: '16px',
                                }}>
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
                                                <div
                                                    key={stage.key}
                                                    style={{
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
                                                    }}
                                                >
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
                                                    position: 'relative',
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

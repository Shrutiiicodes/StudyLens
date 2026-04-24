'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import ProgressCard from '@/components/ProgressCard';
import MasteryGraph from '@/components/MasteryGraph';
import { ArrowLeft, Target, BookOpen, ClipboardList, BarChart2, Search, FileEdit, Trophy, CheckCircle, } from 'lucide-react';
import { ConceptDetail, ConceptProgress, ConceptNode, ConceptRelation } from '@/types/concept';
import { ConceptSessionSummary } from '@/types/session';

// Derive ProgressCard status from stage
function stageToStatus(stage: string): 'locked' | 'unlocked' | 'mastered' {
    if (stage === 'complete') return 'mastered';
    if (stage === 'mastery' || stage === 'practice') return 'unlocked';
    return 'unlocked'; // diagnostic = just started
}

export default function ConceptDetailPage() {
    const params = useParams();
    const router = useRouter();
    const searchParams = useSearchParams();
    const conceptId = params.id as string;

    const [concept, setConcept] = useState<ConceptDetail | null>(null);
    const [progress, setProgress] = useState<ConceptProgress | null>(null);
    const [loading, setLoading] = useState(true);
    const [graphNodes, setGraphNodes] = useState<ConceptNode[]>([]);
    const [graphEdges, setGraphEdges] = useState<ConceptRelation[]>([]);
    const [activeTab, setActiveTab] = useState<'overview' | 'history'>('overview');
    const [sessions, setSessions] = useState<ConceptSessionSummary[]>([]);

    const titleFromUrl = searchParams.get('title');
    const conceptTitle = concept?.title || titleFromUrl || 'Concept';

    useEffect(() => {
        async function fetchData() {
            try {
                const stored = localStorage.getItem('study-lens-user');
                if (!stored) return;
                const user = JSON.parse(stored);

                // Fetch concept details + progress in parallel
                const [conceptsRes, progressRes, graphRes] = await Promise.all([
                    fetch(`/api/concepts?userId=${user.id}`),
                    fetch(`/api/progress?userId=${user.id}&conceptId=${conceptId}`),
                    fetch(`/api/graph?conceptId=${conceptId}&userId=${user.id}`),
                ]);

                const conceptsData = await conceptsRes.json();
                if (conceptsData.success && conceptsData.concepts) {
                    const found = conceptsData.concepts.find((c: ConceptDetail) => c.id === conceptId);
                    if (found) setConcept(found);
                    else if (titleFromUrl) setConcept({ id: conceptId, title: titleFromUrl, source_document: '', created_at: '' });
                }

                // Real mastery + stage from progress API
                const progressData = await progressRes.json();
                if (progressData.success) {
                    setProgress({
                        mastery_score: progressData.masteryScore ?? 0,
                        current_stage: progressData.currentStage ?? 'diagnostic',
                        is_complete: progressData.isComplete ?? false,
                        last_updated: progressData.lastUpdated ?? undefined,
                    });
                }

                // Knowledge graph
                const graphData = await graphRes.json();
                if (graphData.success) {
                    setGraphNodes(graphData.nodes || []);
                    setGraphEdges(graphData.edges || []);
                }
            } catch (err) {
                console.error('Failed to fetch concept data:', err);
            } finally {
                setLoading(false);
            }
        }

        fetchData();
    }, [conceptId, titleFromUrl]);

    const mastery = progress?.mastery_score ?? 0;
    const stage = progress?.current_stage ?? 'diagnostic';
    const isComplete = progress?.is_complete ?? false;
    const cardStatus = stageToStatus(stage);

    // Which test mode button to show as primary CTA
    const nextMode = stage === 'diagnostic' ? 'diagnostic'
        : stage === 'practice' ? 'practice'
            : stage === 'mastery' ? 'mastery'
                : 'mastery'; // complete → still allow re-testing mastery

    if (loading) {
        return (
            <div className="animate-fade-in" style={{ maxWidth: '900px', margin: '0 auto' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                    <div className="glass-card" style={{ padding: '32px', height: '120px', opacity: 0.4 }} />
                    <div className="glass-card" style={{ padding: '32px', height: '200px', opacity: 0.4 }} />
                </div>
            </div>
        );
    }

    return (
        <div className="animate-fade-in" style={{ maxWidth: '900px', margin: '0 auto' }}>
            {/* Back */}
            <button
                className="btn-ghost"
                onClick={() => router.back()}
                style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '24px' }}
            >
                <ArrowLeft size={16} /> Back
            </button>

            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '32px', flexWrap: 'wrap', gap: '16px' }}>
                <div>
                    <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                        {conceptTitle}
                        {isComplete && (
                            <span style={{
                                display: 'inline-flex', alignItems: 'center', gap: '4px',
                                fontSize: '0.8rem', fontWeight: 600, color: 'var(--accent-success)',
                                background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)',
                                padding: '3px 10px', borderRadius: '100px',
                            }}>
                                <CheckCircle size={13} /> Complete
                            </span>
                        )}
                    </h1>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                        Concept extracted from your uploaded document
                    </p>
                </div>

                <div style={{ display: 'flex', gap: '12px' }}>
                    <button
                        className="btn-primary"
                        onClick={() => router.push(`/dashboard/test/${conceptId}?mode=${nextMode}&title=${encodeURIComponent(conceptTitle)}`)}
                        style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                    >
                        <Target size={18} /> Test It
                    </button>
                    <button
                        className="btn-secondary"
                        onClick={() => router.push(`/dashboard/learn/${conceptId}`)}
                        style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                    >
                        <BookOpen size={18} /> Learn It
                    </button>
                </div>
            </div>

            {/* Tab Navigation */}
            <div style={{
                display: 'flex', gap: '4px', marginBottom: '24px',
                background: 'var(--bg-secondary)', padding: '4px',
                borderRadius: 'var(--radius-md)', width: 'fit-content',
            }}>
                {(['overview', 'history'] as const).map((tab) => (
                    <button
                        key={tab}
                        className={tab === activeTab ? 'btn-primary' : 'btn-ghost'}
                        onClick={() => setActiveTab(tab)}
                        style={{ padding: '10px 20px', fontSize: '0.9rem', borderRadius: 'var(--radius-sm)', textTransform: 'capitalize', display: 'flex', alignItems: 'center', gap: '8px' }}
                    >
                        {tab === 'overview' ? <ClipboardList size={16} /> : <BarChart2 size={16} />}
                        {tab}
                    </button>
                ))}
            </div>

            {/* Overview Tab */}
            {activeTab === 'overview' && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px' }}>
                    {/* Assessment Options */}
                    <div className="glass-card" style={{ padding: '24px' }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '20px' }}>Assessment Modes</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            {[
                                { mode: 'diagnostic', label: 'Easy 5', desc: '5 questions to gauge understanding', icon: <Search size={18} color="var(--accent-primary)" />, alwaysEnabled: true },
                                { mode: 'practice', label: 'Practice Test', desc: 'Adaptive difficulty, instant feedback', icon: <FileEdit size={18} color="var(--accent-tertiary)" />, alwaysEnabled: stage !== 'diagnostic' || isComplete },
                                { mode: 'mastery', label: 'Mastery Test', desc: 'Prove complete understanding', icon: <Trophy size={18} color="var(--accent-success)" />, alwaysEnabled: stage === 'mastery' || isComplete },
                            ].map(({ mode, label, desc, icon, alwaysEnabled }) => (
                                <button
                                    key={mode}
                                    className="btn-secondary"
                                    onClick={() => router.push(`/dashboard/test/${conceptId}?mode=${mode}&title=${encodeURIComponent(conceptTitle)}`)}
                                    disabled={!alwaysEnabled}
                                    style={{ justifyContent: 'flex-start', width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '12px', opacity: alwaysEnabled ? 1 : 0.45 }}
                                >
                                    {icon}
                                    <div>
                                        <div style={{ fontWeight: 600 }}>{label}</div>
                                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{desc}</div>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Concept Info */}
                    <div className="glass-card" style={{ padding: '24px' }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '20px' }}>Concept Info</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            {[
                                { label: 'Current Stage', value: isComplete ? 'Complete ✓' : stage.charAt(0).toUpperCase() + stage.slice(1), color: isComplete ? 'var(--accent-success)' : 'var(--accent-primary)' },
                                { label: 'Mastery Score', value: `${Math.round(mastery)}%`, color: mastery >= 80 ? 'var(--accent-success)' : mastery >= 50 ? 'var(--accent-primary)' : 'var(--accent-warning)' },
                                { label: 'Created', value: concept?.created_at ? new Date(concept.created_at).toLocaleDateString() : 'N/A', color: 'var(--text-primary)' },
                            ].map(({ label, value, color }) => (
                                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{label}</span>
                                    <span style={{ fontWeight: 600, fontSize: '0.9rem', color, maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}


            {/* History Tab — Fix 13: real session data */}
            {activeTab === 'history' && (
                sessions.length === 0 ? (
                    <div className="glass-card" style={{ padding: '60px 40px', textAlign: 'center' }}>
                        <BarChart2 size={48} style={{ opacity: 0.3, margin: '0 auto 20px' }} />
                        <p style={{ color: 'var(--text-secondary)' }}>Take some tests first to see your progress over time.</p>
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '4px' }}>{sessions.length} session{sessions.length !== 1 ? 's' : ''} for this concept</p>
                        {sessions.map(s => {
                            const modeLabel: Record<string, string> = { diagnostic: 'Easy 5', practice: 'Practice', mastery: 'Mastery' };
                            const modeColor: Record<string, string> = { diagnostic: '#06b6d4', practice: '#6c5ce7', mastery: '#22c55e' };
                            const c = modeColor[s.mode] ?? 'var(--accent-primary)';
                            return (
                                <div key={s.id} className="glass-card" style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                        <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: c, flexShrink: 0 }} />
                                        <div>
                                            <div style={{ fontWeight: 600, fontSize: '0.9rem', color: c }}>{modeLabel[s.mode] ?? s.mode}</div>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{new Date(s.created_at).toLocaleDateString()}</div>
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                                        {s.nlg !== null && (
                                            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: s.nlg >= 0 ? '#22c55e' : '#ef4444' }}>
                                                {s.nlg >= 0 ? '+' : ''}{Math.round(s.nlg * 100)}% NLG
                                            </span>
                                        )}
                                        <div style={{ textAlign: 'right' }}>
                                            <div style={{ fontWeight: 700, fontSize: '1.1rem', color: s.score >= 80 ? '#22c55e' : s.score >= 60 ? 'var(--accent-primary)' : '#f59e0b' }}>{s.score}%</div>
                                            <div style={{ fontSize: '0.7rem', color: s.passed ? '#22c55e' : 'var(--text-muted)' }}>{s.passed ? '✓ Passed' : 'Not passed'}</div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )
            )}
        </div>
    );
}
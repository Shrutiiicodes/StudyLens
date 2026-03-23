'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import ProgressCard from '@/components/ProgressCard';
import ConceptMap from '@/components/ConceptMap';
import MasteryGraph from '@/components/MasteryGraph';
import {
    ArrowLeft,
    Target,
    BookOpen,
    ClipboardList,
    Share2,
    BarChart2,
    Search,
    FileEdit,
    Trophy,
    Clock
} from 'lucide-react';

interface ConceptDetail {
    id: string;
    title: string;
    source_document: string;
    created_at: string;
}

interface GraphNode {
    id: string;
    label: string;
    type: 'concept' | 'definition' | 'example' | 'formula' | 'misconception';
    properties?: Record<string, string>;
}

interface GraphEdge {
    source: string;
    target: string;
    type: string;
}

export default function ConceptDetailPage() {
    const params = useParams();
    const router = useRouter();
    const searchParams = useSearchParams();
    const conceptId = params.id as string;

    const [concept, setConcept] = useState<ConceptDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
    const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([]);
    const [activeTab, setActiveTab] = useState<'overview' | 'graph' | 'history'>('overview');

    // Get concept title from URL params or fetch from API
    const titleFromUrl = searchParams.get('title');

    useEffect(() => {
        async function fetchConcept() {
            try {
                const stored = localStorage.getItem('study-lens-user');
                if (!stored) return;
                const user = JSON.parse(stored);

                // Fetch concept details
                const res = await fetch(`/api/concepts?userId=${user.id}`);
                const data = await res.json();

                if (data.success && data.concepts) {
                    const found = data.concepts.find((c: ConceptDetail) => c.id === conceptId);
                    if (found) {
                        setConcept(found);
                    } else if (titleFromUrl) {
                        setConcept({ id: conceptId, title: titleFromUrl, source_document: '', created_at: '' });
                    }
                }

                // Fetch knowledge graph
                const graphRes = await fetch(`/api/graph?conceptId=${conceptId}&userId=${user.id}`);
                const graphData = await graphRes.json();

                if (graphData.success) {
                    setGraphNodes(graphData.nodes || []);
                    setGraphEdges(graphData.edges || []);
                }
            } catch (err) {
                console.error('Failed to fetch concept:', err);
                if (titleFromUrl) {
                    setConcept({ id: conceptId, title: titleFromUrl, source_document: '', created_at: '' });
                }
            } finally {
                setLoading(false);
            }
        }

        fetchConcept();
    }, [conceptId, titleFromUrl]);

    const conceptTitle = concept?.title || titleFromUrl || 'Concept';

    if (loading) {
        return (
            <div className="animate-fade-in">
                <div className="glass-card skeleton" style={{ height: '200px', marginBottom: '24px' }} />
                <div className="glass-card skeleton" style={{ height: '300px' }} />
            </div>
        );
    }

    return (
        <div className="animate-fade-in">
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '32px', flexWrap: 'wrap', gap: '16px' }}>
                <div>
                    <button
                        className="btn-ghost"
                        onClick={() => router.back()}
                        style={{ marginBottom: '12px', padding: '6px 0', display: 'flex', alignItems: 'center', gap: '8px' }}
                    >
                        <ArrowLeft size={18} /> Back
                    </button>
                    <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '8px' }}>
                        {conceptTitle}
                    </h1>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '1rem', maxWidth: '600px' }}>
                        Concept extracted from your uploaded document
                    </p>
                </div>

                <div style={{ display: 'flex', gap: '12px' }}>
                    <button
                        className="btn-primary"
                        onClick={() => router.push(`/dashboard/test/${conceptId}?mode=diagnostic&title=${encodeURIComponent(conceptTitle)}`)}
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

            {/* Mastery Card */}
            <div style={{ maxWidth: '400px', marginBottom: '32px' }}>
                <ProgressCard
                    title={conceptTitle}
                    mastery={0}
                    status="unlocked"
                />
            </div>

            {/* Tab Navigation */}
            <div style={{
                display: 'flex',
                gap: '4px',
                marginBottom: '24px',
                background: 'var(--bg-secondary)',
                padding: '4px',
                borderRadius: 'var(--radius-md)',
                width: 'fit-content',
            }}>
                {(['overview', 'graph', 'history'] as const).map((tab) => (
                    <button
                        key={tab}
                        className={tab === activeTab ? 'btn-primary' : 'btn-ghost'}
                        onClick={() => setActiveTab(tab)}
                        style={{
                            padding: '10px 20px',
                            fontSize: '0.9rem',
                            borderRadius: 'var(--radius-sm)',
                            textTransform: 'capitalize',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                        }}
                    >
                        {tab === 'overview' ? <ClipboardList size={16} /> : tab === 'graph' ? <Share2 size={16} /> : <BarChart2 size={16} />} {tab}
                    </button>
                ))}
            </div>

            {/* Tab Content */}
            {activeTab === 'overview' && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px' }}>
                    {/* Assessment Options */}
                    <div className="glass-card" style={{ padding: '24px' }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '20px' }}>Assessment Modes</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            <button
                                className="btn-secondary"
                                onClick={() => router.push(`/dashboard/test/${conceptId}?mode=diagnostic&title=${encodeURIComponent(conceptTitle)}`)}
                                style={{ justifyContent: 'flex-start', width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '12px' }}
                            >
                                <Search size={18} color="var(--accent-primary)" />
                                <div>
                                    <div style={{ fontWeight: 600 }}>Diagnostic Test</div>
                                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>5 questions to gauge understanding</div>
                                </div>
                            </button>
                            <button
                                className="btn-secondary"
                                onClick={() => router.push(`/dashboard/test/${conceptId}?mode=practice&title=${encodeURIComponent(conceptTitle)}`)}
                                style={{ justifyContent: 'flex-start', width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '12px' }}
                            >
                                <FileEdit size={18} color="var(--accent-tertiary)" />
                                <div>
                                    <div style={{ fontWeight: 600 }}>Practice Mode</div>
                                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Adaptive difficulty, instant feedback</div>
                                </div>
                            </button>
                            <button
                                className="btn-secondary"
                                onClick={() => router.push(`/dashboard/test/${conceptId}?mode=mastery&title=${encodeURIComponent(conceptTitle)}`)}
                                style={{ justifyContent: 'flex-start', width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '12px' }}
                            >
                                <Trophy size={18} color="var(--accent-success)" />
                                <div>
                                    <div style={{ fontWeight: 600 }}>Mastery Test</div>
                                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Prove complete understanding</div>
                                </div>
                            </button>

                        </div>
                    </div>

                    {/* Info */}
                    <div className="glass-card" style={{ padding: '24px' }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '20px' }}>Concept Info</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Source Document</span>
                                <span style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--accent-primary)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {concept?.source_document?.split('/').pop() || 'N/A'}
                                </span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Graph Nodes</span>
                                <span style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--accent-tertiary)' }}>
                                    {graphNodes.length}
                                </span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Created</span>
                                <span style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                                    {concept?.created_at ? new Date(concept.created_at).toLocaleDateString() : 'N/A'}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {activeTab === 'graph' && (
                graphNodes.length > 0 ? (
                    <ConceptMap nodes={graphNodes} edges={graphEdges} />
                ) : (
                    <div className="glass-card" style={{ padding: '60px 40px', textAlign: 'center' }}>
                        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '20px' }}>
                            <Share2 size={48} style={{ opacity: 0.3 }} />
                        </div>
                        <p style={{ color: 'var(--text-secondary)' }}>
                            Knowledge graph not available. The graph is built during document upload using Neo4j.
                        </p>
                    </div>
                )
            )}

            {activeTab === 'history' && (
                <div className="glass-card" style={{ padding: '60px 40px', textAlign: 'center' }}>
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '20px' }}>
                        <BarChart2 size={48} style={{ opacity: 0.3 }} />
                    </div>
                    <p style={{ color: 'var(--text-secondary)' }}>
                        Take some tests first to see your mastery progress over time.
                    </p>
                </div>
            )}
        </div>
    );
}

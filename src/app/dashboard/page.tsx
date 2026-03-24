'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
    FileText,
    Target,
    BarChart,
    BookOpen,
    Book,
    ClipboardList,
    Rocket,
    Brain,
    Search,
    Sparkles
} from 'lucide-react';

interface ConceptRecord {
    id: string;
    title: string;
    source_document: string;
    created_at: string;
}

export default function DashboardPage() {
    const [user, setUser] = useState<{ id: string; full_name: string; grade: number } | null>(null);
    const [concepts, setConcepts] = useState<ConceptRecord[]>([]);
    const [stats, setStats] = useState<{ testsTaken: number; abilityIndex: number } | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const stored = localStorage.getItem('study-lens-user');
        if (stored) {
            const parsed = JSON.parse(stored);
            setUser(parsed);

            // Fetch real concepts
            const fetchConcepts = fetch(`/api/concepts?userId=${parsed.id}`, { cache: 'no-store' }).then((res) => res.json());

            // Fetch stats
            const fetchStats = fetch(`/api/user/stats?userId=${parsed.id}`, { cache: 'no-store' }).then((res) => res.json());

            Promise.all([fetchConcepts, fetchStats])
                .then(([conceptsData, statsData]) => {
                    if (conceptsData.success && conceptsData.concepts) {
                        setConcepts(conceptsData.concepts);
                    }
                    if (statsData.success && statsData.stats) {
                        setStats(statsData.stats);
                    }
                })
                .catch(console.error)
                .finally(() => setLoading(false));
        } else {
            setLoading(false);
        }
    }, []);

    return (
        <div className="animate-fade-in">
            {/* Header */}
            <div style={{ marginBottom: '32px' }}>
                <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    Welcome back, <span className="gradient-text">{user?.full_name || 'Student'}</span>
                </h1>
                <p style={{ color: 'var(--text-secondary)', fontSize: '1rem' }}>
                    Here&apos;s your learning progress overview
                </p>
            </div>

            {/* Stats Grid */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: '16px',
                marginBottom: '32px',
            }}>
                {[
                    { label: 'Documents Uploaded', value: `${concepts.length}`, icon: <FileText size={24} />, gradient: 'var(--gradient-primary)' },
                    { label: 'Tests Taken', value: stats ? `${stats.testsTaken}` : '0', icon: <Target size={24} />, gradient: 'var(--gradient-warm)' },
                    { label: 'Ability Index', value: stats ? `${stats.abilityIndex}` : '0', icon: <BarChart size={24} />, gradient: 'var(--gradient-secondary)' },
                ].map((stat, idx) => (
                    <div key={idx} className="stat-card" style={{ position: 'relative', overflow: 'hidden' }}>
                        <div style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            height: '3px',
                            background: stat.gradient,
                        }} />
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div>
                                <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '8px' }}>
                                    {stat.label}
                                </p>
                                <p style={{ fontSize: '1.8rem', fontWeight: 700 }}>{stat.value}</p>
                            </div>
                            <span style={{ fontSize: '2rem' }}>{stat.icon}</span>
                        </div>
                    </div>
                ))}
            </div>

            {/* Section: Concepts */}
            <div style={{ marginBottom: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                    <h2 style={{ fontSize: '1.3rem', fontWeight: 600 }}>Your Learning Path</h2>
                    <Link href="/dashboard/upload" className="btn-primary" style={{ textDecoration: 'none', padding: '10px 20px', fontSize: '0.9rem' }}>
                        + Upload New
                    </Link>
                </div>

                {loading ? (
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                        gap: '16px',
                    }}>
                        {[1, 2, 3].map((i) => (
                            <div key={i} className="glass-card skeleton" style={{ height: '120px' }} />
                        ))}
                    </div>
                ) : concepts.length === 0 ? (
                    <div className="glass-card" style={{ padding: '60px 40px', textAlign: 'center' }}>
                        <div style={{ fontSize: '3rem', marginBottom: '16px', display: 'flex', justifyContent: 'center' }}>
                            <BookOpen size={48} color="var(--text-muted)" />
                        </div>
                        <h3 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '12px' }}>
                            No concepts yet
                        </h3>
                        <p style={{ color: 'var(--text-secondary)', marginBottom: '24px', maxWidth: '400px', margin: '0 auto 24px' }}>
                            Upload a PDF or DOCX document to extract concepts, build a knowledge graph, and start adaptive testing.
                        </p>
                        <Link href="/dashboard/upload" className="btn-primary" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                            <FileText size={18} /> Upload Your First Document
                        </Link>
                    </div>
                ) : (
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                        gap: '16px',
                    }}>
                        {concepts.map((concept) => (
                            <div key={concept.id} className="glass-card" style={{ padding: '20px' }}>
                                <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                                    <FileText size={18} style={{ flexShrink: 0 }} />
                                    <span>{concept.title}</span>
                                </h3>
                                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '14px' }}>
                                    Uploaded {new Date(concept.created_at).toLocaleDateString()}
                                </p>
                                <div style={{ display: 'flex', gap: '8px' }}>
                                    <Link
                                        href={`/dashboard/learn/${concept.id}`}
                                        className="btn-secondary"
                                        style={{ textDecoration: 'none', fontSize: '0.8rem', padding: '7px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
                                    >
                                        <Book size={14} /> Learn
                                    </Link>
                                    <Link
                                        href="/dashboard/concepts"
                                        className="btn-primary"
                                        style={{ textDecoration: 'none', fontSize: '0.8rem', padding: '7px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
                                    >
                                        <ClipboardList size={14} /> Progress
                                    </Link>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Getting Started Guide */}
            {concepts.length === 0 && (
                <div className="glass-card" style={{ padding: '24px' }}>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <Rocket size={20} className="text-primary" /> Getting Started
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {[
                            { step: '1', text: 'Upload a PDF or DOCX study material', icon: <FileText size={16} /> },
                            { step: '2', text: 'AI extracts concepts and builds a knowledge graph', icon: <Brain size={16} /> },
                            { step: '3', text: 'Take an Easy 5 test to assess your understanding', icon: <Search size={16} /> },
                            { step: '4', text: 'Get personalized practice based on your mastery level', icon: <Target size={16} /> },
                        ].map((item) => (
                            <div key={item.step} style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '16px',
                                padding: '14px 16px',
                                borderRadius: 'var(--radius-md)',
                                background: 'var(--bg-glass)',
                                border: '1px solid var(--border-subtle)',
                            }}>
                                <span style={{
                                    width: '32px',
                                    height: '32px',
                                    borderRadius: '50%',
                                    background: 'var(--gradient-primary)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontWeight: 700,
                                    fontSize: '0.85rem',
                                    flexShrink: 0,
                                }}>
                                    {item.step}
                                </span>
                                <span style={{ fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    {item.icon} {item.text}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

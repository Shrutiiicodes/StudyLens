'use client';

import { useState, useEffect } from 'react';
import ReviewQueue from '@/components/ReviewQueue';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
    FileText,
    Target,
    BookOpen,
    Book,
    ClipboardList,
    Rocket,
    Brain,
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
    const [stats, setStats] = useState<{ testsTaken: number; } | null>(null);
    const [loading, setLoading] = useState(true);
    const router = useRouter();

    useEffect(() => {
        const stored = localStorage.getItem('study-lens-user');
        if (stored) {
            const parsed = JSON.parse(stored);
            setUser(parsed);

            const fetchConcepts = fetch(`/api/concepts?userId=${parsed.id}`, { cache: 'no-store' }).then((res) => res.json());
            const fetchStats = fetch(`/api/user/stats?userId=${parsed.id}`, { cache: 'no-store' }).then((res) => res.json());

            Promise.all([fetchConcepts, fetchStats])
                .then(([conceptsData, statsData]) => {
                    if (conceptsData.success && conceptsData.concepts) setConcepts(conceptsData.concepts);
                    if (statsData.success && statsData.stats) setStats(statsData.stats);
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '32px' }}>
                {/* Documents */}
                <div className="stat-card" style={{ position: 'relative', overflow: 'hidden' }}>
                    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '3px', background: 'var(--gradient-primary)' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '8px' }}>Documents Uploaded</p>
                            <p style={{ fontSize: '1.8rem', fontWeight: 700 }}>{concepts.length}</p>
                        </div>
                        <FileText size={24} />
                    </div>
                </div>

                {/* Tests Taken */}
                <div className="stat-card" style={{ position: 'relative', overflow: 'hidden' }}>
                    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '3px', background: 'var(--gradient-warm)' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '8px' }}>Tests Taken</p>
                            <p style={{ fontSize: '1.8rem', fontWeight: 700 }}>{stats?.testsTaken ?? '0'}</p>
                        </div>
                        <Target size={24} />
                    </div>
                </div>
            </div>

            {/* Concepts Section */}
            <div style={{ marginBottom: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                    <h2 style={{ fontSize: '1.3rem', fontWeight: 600 }}>Your Learning Path</h2>
                    <Link href="/dashboard/upload" className="btn-primary" style={{ textDecoration: 'none', padding: '10px 20px', fontSize: '0.9rem' }}>
                        + Upload New
                    </Link>
                </div>

                {loading ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '16px' }}>
                        {[1, 2, 3].map((i) => (
                            <div key={i} className="glass-card skeleton" style={{ height: '120px' }} />
                        ))}
                    </div>
                ) : concepts.length === 0 ? (
                    <div className="glass-card" style={{ padding: '48px', textAlign: 'center' }}>
                        <Brain size={48} style={{ margin: '0 auto 16px', opacity: 0.3 }} />
                        <h3 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '8px' }}>No concepts yet</h3>
                        <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>
                            Upload a PDF or DOCX to get started
                        </p>
                        <Link href="/dashboard/upload" className="btn-primary" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                            <Rocket size={18} /> Upload Document
                        </Link>
                    </div>
                ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
                        {concepts.slice(0, 6).map((concept) => (
                            <div
                                key={concept.id}
                                style={{ textDecoration: 'none', cursor: 'pointer' }}
                                onClick={() => router.push(`/dashboard/concept/${concept.id}?title=${encodeURIComponent(concept.title)}`)}
                            >
                                <div className="glass-card" style={{ padding: '20px', cursor: 'pointer', transition: 'transform 0.15s ease' }}
                                    onMouseOver={e => (e.currentTarget.style.transform = 'translateY(-2px)')}
                                    onMouseOut={e => (e.currentTarget.style.transform = 'translateY(0)')}>
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                                        <div style={{ padding: '10px', borderRadius: '10px', background: 'var(--bg-elevated)', flexShrink: 0 }}>
                                            <FileText size={18} color="var(--accent-primary)" />
                                        </div>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <h3 style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {concept.title}
                                            </h3>
                                            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                                {new Date(concept.created_at).toLocaleDateString()}
                                            </p>
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
                                        <Link href={`/dashboard/learn/${concept.id}`} className="btn-secondary"
                                            style={{ textDecoration: 'none', fontSize: '0.8rem', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px', flex: 1, justifyContent: 'center' }}
                                            onClick={e => e.stopPropagation()}>
                                            <Book size={14} /> Learn
                                        </Link>
                                        <Link href={`/dashboard/concepts`} className="btn-primary"
                                            style={{ textDecoration: 'none', fontSize: '0.8rem', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px', flex: 1, justifyContent: 'center' }}
                                            onClick={e => e.stopPropagation()}>
                                            <ClipboardList size={14} /> Progress
                                        </Link>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {concepts.length > 6 && (
                    <div style={{ textAlign: 'center', marginTop: '16px' }}>
                        <Link href="/dashboard/concepts" className="btn-secondary" style={{ textDecoration: 'none' }}>
                            View all {concepts.length} concepts →
                        </Link>
                    </div>
                )}
            </div>
            {user && <ReviewQueue userId={user.id} />}
        </div>
    );
}
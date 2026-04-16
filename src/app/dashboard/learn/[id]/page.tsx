'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
    ArrowLeft,
    Rocket,
    AlertTriangle,
    Target,
    Pencil,
    Trophy,
    Brain,
    Book,
    CheckCircle,
    Info,
    Lightbulb,
    HelpCircle,
    ClipboardList,
    FileText,
    Activity,
    Zap,
    Star,
    Search,
    Users,
    Lock,
} from 'lucide-react';

const lucideIcons: Record<string, any> = {
    Brain, Book, CheckCircle, Info, Lightbulb, HelpCircle,
    ClipboardList, FileText, Activity, Zap, Star, Search,
    Users, Target, Trophy, Pencil, Rocket, AlertTriangle,
};

const DynamicIcon = ({ name, size = 24 }: { name: string; size?: number }) => {
    const IconComponent = lucideIcons[name] || HelpCircle;
    return <IconComponent size={size} />;
};

interface LearnSection {
    heading: string;
    icon: string;
    type: 'explanation' | 'example' | 'misconception' | 'visual' | 'formula';
    content: string;
    imagePrompt?: string;
}

interface LearnContent {
    title: string;
    sections: LearnSection[];
}

const sectionTypeStyles: Record<string, { accent: string; bg: string; iconBg: string }> = {
    explanation: { accent: '#6c5ce7', bg: 'rgba(108,92,231,0.04)', iconBg: 'rgba(108,92,231,0.12)' },
    example: { accent: '#06b6d4', bg: 'rgba(6,182,212,0.04)', iconBg: 'rgba(6,182,212,0.12)' },
    misconception: { accent: '#f59e0b', bg: 'rgba(245,158,11,0.04)', iconBg: 'rgba(245,158,11,0.12)' },
    visual: { accent: '#22c55e', bg: 'rgba(34,197,94,0.04)', iconBg: 'rgba(34,197,94,0.12)' },
    formula: { accent: '#a855f7', bg: 'rgba(168,85,247,0.04)', iconBg: 'rgba(168,85,247,0.12)' },
};

export default function LearnPage() {
    const params = useParams();
    const router = useRouter();
    const conceptId = params.id as string;

    const [content, setContent] = useState<LearnContent | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // Fix 16: track current stage so CTA shows correct next test
    const [currentStage, setCurrentStage] = useState<string>('diagnostic');
    const [isComplete, setIsComplete] = useState(false);

    useEffect(() => {
        async function fetchLearn() {
            try {
                const stored = localStorage.getItem('study-lens-user');
                const user = stored ? JSON.parse(stored) : null;
                const grade = user?.grade || 10;

                // Fix 16: fetch stage in parallel with learn content
                const [learnRes, progressRes] = await Promise.all([
                    fetch(`/api/learn?conceptId=${conceptId}&grade=${grade}`),
                    user
                        ? fetch(`/api/progress?userId=${user.id}&conceptId=${conceptId}`)
                        : Promise.resolve(null),
                ]);

                const data = await learnRes.json();
                if (data.success) {
                    setContent(data.content);
                } else {
                    setError(data.error || 'Failed to load lesson content');
                }

                if (progressRes) {
                    const progressData = await progressRes.json();
                    if (progressData.success) {
                        setCurrentStage(progressData.currentStage ?? 'diagnostic');
                        setIsComplete(progressData.isComplete ?? false);
                    }
                }
            } catch (err) {
                setError('Network error. Please try again.');
            } finally {
                setLoading(false);
            }
        }
        fetchLearn();
    }, [conceptId]);

    // Fix 16: derive which test buttons to show based on stage
    const showPractice = currentStage !== 'diagnostic' || isComplete;
    const showMastery = currentStage === 'mastery' || isComplete;
    // Always show diagnostic as a fallback option
    const primaryMode = currentStage === 'diagnostic' ? 'diagnostic'
        : currentStage === 'practice' ? 'practice'
            : 'mastery';

    // ── Loading ───────────────────────────────────────────────────────
    if (loading) {
        return (
            <div className="animate-fade-in" style={{ maxWidth: '800px', margin: '0 auto' }}>
                <div className="glass-card" style={{ padding: '60px 40px', textAlign: 'center' }}>
                    <div style={{ width: '60px', height: '60px', border: '3px solid var(--border-subtle)', borderTop: '3px solid var(--accent-primary)', borderRadius: '50%', animation: 'spin-slow 1s linear infinite', margin: '0 auto 24px' }} />
                    <h2 style={{ fontSize: '1.4rem', fontWeight: 600, marginBottom: '12px' }}>Preparing Your Lesson...</h2>
                    <p style={{ color: 'var(--text-secondary)' }}>AI is generating personalised learning material.</p>
                </div>
            </div>
        );
    }

    // ── Error ─────────────────────────────────────────────────────────
    if (error || !content) {
        return (
            <div className="animate-fade-in" style={{ maxWidth: '800px', margin: '0 auto' }}>
                <div className="glass-card" style={{ padding: '40px', textAlign: 'center' }}>
                    <AlertTriangle size={48} style={{ margin: '0 auto 16px', color: 'var(--accent-warning)' }} />
                    <h2 style={{ fontSize: '1.4rem', fontWeight: 600, marginBottom: '12px' }}>Couldn&apos;t Load Lesson</h2>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>{error}</p>
                    <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                        <button className="btn-primary" onClick={() => window.location.reload()}>Try Again</button>
                        <button className="btn-secondary" onClick={() => router.back()}>← Go Back</button>
                    </div>
                </div>
            </div>
        );
    }

    // ── Content ───────────────────────────────────────────────────────
    return (
        <div className="animate-fade-in" style={{ maxWidth: '800px', margin: '0 auto' }}>
            {/* Back */}
            <button className="btn-ghost" onClick={() => router.back()} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '24px' }}>
                <ArrowLeft size={16} /> Back
            </button>

            {/* Header */}
            <div style={{ marginBottom: '48px' }}>
                <h1 style={{ fontSize: '2.2rem', fontWeight: 800, marginBottom: '12px' }}>
                    {content.title}
                </h1>
                <p style={{ color: 'var(--text-secondary)', fontSize: '1rem' }}>
                    {content.sections.length} knowledge placards · Read through all before testing
                </p>
            </div>

            {/* Sections */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
                {content.sections.map((section, idx) => {
                    const styles = sectionTypeStyles[section.type] || sectionTypeStyles.explanation;
                    return (
                        <div key={idx} className="glass-card animate-fade-in" style={{
                            padding: '40px',
                            borderLeft: `8px solid ${styles.accent}`,
                            background: styles.bg,
                            position: 'relative',
                        }}>
                            <div style={{ position: 'absolute', top: '20px', right: '30px', fontSize: '2rem', opacity: 0.1 }}>{idx + 1}</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
                                <div style={{ width: '48px', height: '48px', borderRadius: '12px', background: styles.iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', color: styles.accent, flexShrink: 0 }}>
                                    <DynamicIcon name={section.icon} size={28} />
                                </div>
                                <h2 style={{ fontSize: '1.6rem', fontWeight: 800 }}>{section.heading}</h2>
                            </div>
                            <div style={{ color: 'var(--text-primary)', fontSize: '1.1rem', lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>
                                {section.content}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Fix 16: Stage-aware CTA — only show unlocked tests */}
            <div className="glass-card animate-pulse-glow" style={{
                padding: '60px 40px',
                marginTop: '64px',
                textAlign: 'center',
                background: 'linear-gradient(135deg, rgba(108,92,231,0.15), rgba(6,182,212,0.15))',
                borderRadius: 'var(--radius-xl)',
                border: '1px solid var(--accent-primary)',
            }}>
                <h3 style={{ fontSize: '1.8rem', fontWeight: 900, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px', justifyContent: 'center' }}>
                    {isComplete ? 'Revisit Your Knowledge' : 'Assessment Unlocked!'} <Target size={28} />
                </h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '1.1rem', maxWidth: '560px', margin: '0 auto 40px' }}>
                    {isComplete
                        ? 'You\'ve mastered this concept. Retake any test to reinforce retention.'
                        : 'You\'ve explored all the knowledge placards. Ready to test yourself?'}
                </p>

                <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap' }}>
                    {/* Diagnostic — always visible */}
                    <button
                        className={primaryMode === 'diagnostic' ? 'btn-primary' : 'btn-secondary'}
                        onClick={() => router.push(`/dashboard/test/${conceptId}?mode=diagnostic`)}
                        style={{ padding: '16px 36px', fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '10px' }}
                    >
                        <Search size={18} /> Easy 5
                    </button>

                    {/* Practice — only if unlocked */}
                    {showPractice ? (
                        <button
                            className={primaryMode === 'practice' ? 'btn-primary' : 'btn-secondary'}
                            onClick={() => router.push(`/dashboard/test/${conceptId}?mode=practice`)}
                            style={{ padding: '16px 36px', fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '10px' }}
                        >
                            <Pencil size={18} /> Practice Test
                        </button>
                    ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '16px 36px', borderRadius: 'var(--radius-md)', background: 'var(--bg-elevated)', opacity: 0.5, fontSize: '1rem', color: 'var(--text-muted)' }}>
                            <Lock size={16} /> Practice Test
                        </div>
                    )}

                    {/* Mastery — only if unlocked */}
                    {showMastery ? (
                        <button
                            className={primaryMode === 'mastery' ? 'btn-primary' : 'btn-secondary'}
                            onClick={() => router.push(`/dashboard/test/${conceptId}?mode=mastery`)}
                            style={{ padding: '16px 36px', fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '10px' }}
                        >
                            <Trophy size={18} /> Mastery Test
                        </button>
                    ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '16px 36px', borderRadius: 'var(--radius-md)', background: 'var(--bg-elevated)', opacity: 0.5, fontSize: '1rem', color: 'var(--text-muted)' }}>
                            <Lock size={16} /> Mastery Test
                        </div>
                    )}
                </div>

                {!isComplete && currentStage === 'diagnostic' && (
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '20px' }}>
                        Pass Easy 5 to unlock Practice Test · Pass Practice to unlock Mastery Test
                    </p>
                )}
            </div>
        </div>
    );
}
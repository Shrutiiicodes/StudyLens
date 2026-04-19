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
    XCircle,
    ChevronDown,
    ChevronUp,
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

// ── Types ─────────────────────────────────────────────────────────────────────

// Shape returned when KG has content
interface KGContent {
    title: string;
    kgSections: {
        definition: string;
        examples: string[];
        formulas: string[];
        knownMisconceptions: string[];
    };
    pastMisconceptions: PastMisconception[];
}

// Shape returned by LLM fallback (original format)
interface LLMSection {
    heading: string;
    icon: string;
    type: 'explanation' | 'example' | 'misconception' | 'visual' | 'formula';
    content: string;
}

interface LLMContent {
    title: string;
    sections: LLMSection[];
    pastMisconceptions: PastMisconception[];
}

interface PastMisconception {
    question_text: string;
    selected_answer: string;
    correct_answer: string;
    explanation: string;
    created_at: string;
}

type LearnContent = KGContent | LLMContent;

function isKGContent(c: LearnContent): c is KGContent {
    return 'kgSections' in c;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const sectionTypeStyles: Record<string, { accent: string; bg: string; iconBg: string }> = {
    explanation: { accent: '#6c5ce7', bg: 'rgba(108,92,231,0.04)', iconBg: 'rgba(108,92,231,0.12)' },
    example: { accent: '#06b6d4', bg: 'rgba(6,182,212,0.04)', iconBg: 'rgba(6,182,212,0.12)' },
    misconception: { accent: '#f59e0b', bg: 'rgba(245,158,11,0.04)', iconBg: 'rgba(245,158,11,0.12)' },
    visual: { accent: '#22c55e', bg: 'rgba(34,197,94,0.04)', iconBg: 'rgba(34,197,94,0.12)' },
    formula: { accent: '#a855f7', bg: 'rgba(168,85,247,0.04)', iconBg: 'rgba(168,85,247,0.12)' },
};

// ── Subcomponents ─────────────────────────────────────────────────────────────

function KGPlacards({ kgSections }: { kgSections: KGContent['kgSections'] }) {
    const placards: Array<{ type: string; heading: string; icon: string; items: string[] }> = [];

    if (kgSections.definition) {
        placards.push({ type: 'explanation', heading: 'Definition', icon: 'Brain', items: [kgSections.definition] });
    }
    if (kgSections.examples.length > 0) {
        placards.push({ type: 'example', heading: 'Examples', icon: 'Lightbulb', items: kgSections.examples });
    }
    if (kgSections.formulas.length > 0) {
        placards.push({ type: 'formula', heading: 'Formulas', icon: 'Zap', items: kgSections.formulas });
    }
    if (kgSections.knownMisconceptions.length > 0) {
        placards.push({ type: 'misconception', heading: 'Common Misconceptions', icon: 'AlertTriangle', items: kgSections.knownMisconceptions });
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
            {placards.map((placard, idx) => {
                const styles = sectionTypeStyles[placard.type] || sectionTypeStyles.explanation;
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
                                <DynamicIcon name={placard.icon} size={28} />
                            </div>
                            <h2 style={{ fontSize: '1.6rem', fontWeight: 800 }}>{placard.heading}</h2>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            {placard.items.map((item, i) => (
                                <p key={i} style={{ color: 'var(--text-primary)', fontSize: '1.05rem', lineHeight: 1.8 }}>
                                    {placard.items.length > 1 && (
                                        <span style={{ color: styles.accent, fontWeight: 700, marginRight: '8px' }}>{i + 1}.</span>
                                    )}
                                    {item}
                                </p>
                            ))}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

function LLMPlacards({ sections }: { sections: LLMSection[] }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
            {sections.map((section, idx) => {
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
    );
}

function PastMisconceptionsSection({ items }: { items: PastMisconception[] }) {
    const [expanded, setExpanded] = useState<number | null>(null);

    if (items.length === 0) return null;

    return (
        <div style={{ marginTop: '48px' }}>
            {/* Section header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                <div style={{ width: '4px', height: '32px', background: '#ef4444', borderRadius: '2px' }} />
                <div>
                    <h2 style={{ fontSize: '1.3rem', fontWeight: 800, margin: 0 }}>Where You Went Wrong</h2>
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '4px 0 0' }}>
                        Based on your past test attempts · {items.length} question{items.length > 1 ? 's' : ''} to review
                    </p>
                </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {items.map((item, idx) => {
                    const isOpen = expanded === idx;
                    return (
                        <div key={idx} className="glass-card" style={{
                            borderLeft: '8px solid #ef4444',
                            background: 'rgba(239,68,68,0.04)',
                            overflow: 'hidden',
                        }}>
                            {/* Question row — always visible */}
                            <button
                                onClick={() => setExpanded(isOpen ? null : idx)}
                                style={{
                                    width: '100%',
                                    padding: '20px 24px',
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'flex-start',
                                    gap: '16px',
                                    textAlign: 'left',
                                }}
                            >
                                <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', flex: 1 }}>
                                    <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: 'rgba(239,68,68,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: '2px' }}>
                                        <XCircle size={18} color="#ef4444" />
                                    </div>
                                    <p style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.5, margin: 0 }}>
                                        {item.question_text}
                                    </p>
                                </div>
                                {isOpen ? <ChevronUp size={18} color="var(--text-muted)" style={{ flexShrink: 0, marginTop: '4px' }} /> : <ChevronDown size={18} color="var(--text-muted)" style={{ flexShrink: 0, marginTop: '4px' }} />}
                            </button>

                            {/* Expanded detail */}
                            {isOpen && (
                                <div style={{ padding: '0 24px 24px', borderTop: '1px solid rgba(239,68,68,0.15)' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', paddingTop: '16px' }}>
                                        {/* What they answered */}
                                        <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                                            <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#ef4444', background: 'rgba(239,68,68,0.12)', padding: '3px 8px', borderRadius: '4px', flexShrink: 0, marginTop: '2px' }}>
                                                YOUR ANSWER
                                            </span>
                                            <p style={{ fontSize: '0.95rem', color: 'var(--text-secondary)', margin: 0, textDecoration: 'line-through', lineHeight: 1.5 }}>
                                                {item.selected_answer || '—'}
                                            </p>
                                        </div>
                                        {/* Correct answer */}
                                        <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                                            <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#22c55e', background: 'rgba(34,197,94,0.12)', padding: '3px 8px', borderRadius: '4px', flexShrink: 0, marginTop: '2px' }}>
                                                CORRECT
                                            </span>
                                            <p style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)', margin: 0, lineHeight: 1.5 }}>
                                                {item.correct_answer}
                                            </p>
                                        </div>
                                        {/* Explanation */}
                                        {item.explanation && (
                                            <div style={{ marginTop: '4px', padding: '12px 16px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
                                                <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>
                                                    {item.explanation}
                                                </p>
                                            </div>
                                        )}
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

export default function LearnPage() {
    const params = useParams();
    const router = useRouter();
    const conceptId = params.id as string;

    const [content, setContent] = useState<LearnContent | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [currentStage, setCurrentStage] = useState<string>('diagnostic');
    const [isComplete, setIsComplete] = useState(false);

    useEffect(() => {
        async function fetchLearn() {
            try {
                const stored = localStorage.getItem('study-lens-user');
                const user = stored ? JSON.parse(stored) : null;
                const grade = user?.grade || 10;
                const userId = user?.id || '';

                const [learnRes, progressRes] = await Promise.all([
                    fetch(`/api/learn?conceptId=${conceptId}&grade=${grade}&userId=${userId}`),
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

    const showPractice = currentStage !== 'diagnostic' || isComplete;
    const showMastery = currentStage === 'mastery' || isComplete;
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
                    <p style={{ color: 'var(--text-secondary)' }}>Loading personalised learning material.</p>
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

    const pastMisconceptions = content.pastMisconceptions ?? [];
    const placardsCount = isKGContent(content)
        ? Object.values(content.kgSections).filter(v => (Array.isArray(v) ? v.length > 0 : !!v)).length
        : (content as LLMContent).sections?.length ?? 0;

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
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '1rem', margin: 0 }}>
                        {placardsCount} knowledge placard{placardsCount !== 1 ? 's' : ''} · Read through all before testing
                    </p>
                    {pastMisconceptions.length > 0 && (
                        <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#ef4444', background: 'rgba(239,68,68,0.1)', padding: '3px 10px', borderRadius: '20px', border: '1px solid rgba(239,68,68,0.2)' }}>
                            {pastMisconceptions.length} gap{pastMisconceptions.length > 1 ? 's' : ''} to review
                        </span>
                    )}
                </div>
            </div>

            {/* Base content — KG or LLM */}
            {isKGContent(content)
                ? <KGPlacards kgSections={content.kgSections} />
                : <LLMPlacards sections={(content as LLMContent).sections} />
            }

            {/* Past misconceptions — only if user has history */}
            <PastMisconceptionsSection items={pastMisconceptions} />

            {/* CTA */}
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
                        ? "You've mastered this concept. Retake any test to reinforce retention."
                        : "You've explored all the knowledge placards. Ready to test yourself?"}
                </p>

                <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap' }}>
                    <button
                        className={primaryMode === 'diagnostic' ? 'btn-primary' : 'btn-secondary'}
                        onClick={() => router.push(`/dashboard/test/${conceptId}?mode=diagnostic`)}
                        style={{ padding: '16px 36px', fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '10px' }}
                    >
                        <Search size={18} /> Easy 5
                    </button>

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
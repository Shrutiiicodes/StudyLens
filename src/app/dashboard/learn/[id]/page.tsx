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
  Users
} from 'lucide-react';

// Map of common icons for dynamic lookup
const lucideIcons: Record<string, any> = {
    Brain, Book, CheckCircle, Info, Lightbulb, HelpCircle, 
    ClipboardList, FileText, Activity, Zap, Star, Search, 
    Users, Target, Trophy, Pencil, Rocket, AlertTriangle
};

const DynamicIcon = ({ name, size = 24 }: { name: string, size?: number }) => {
    // If the name matches a known icon, return it
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

export default function LearnPage() {
    const params = useParams();
    const router = useRouter();
    const conceptId = params.id as string;

    const [content, setContent] = useState<LearnContent | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        async function fetchLearn() {
            try {
                const stored = localStorage.getItem('study-lens-user');
                const user = stored ? JSON.parse(stored) : null;
                const grade = user?.grade || 10;

                const res = await fetch(`/api/learn?conceptId=${conceptId}&grade=${grade}`);
                const data = await res.json();
                if (data.success) {
                    setContent(data.content);
                } else {
                    setError(data.error || 'Failed to load lesson content');
                }
            } catch (err) {
                setError('Network error. Please try again.');
            } finally {
                setLoading(false);
            }
        }
        fetchLearn();
    }, [conceptId]);

    const sectionTypeStyles: Record<string, { bg: string; border: string; accent: string; iconBg: string }> = {
        explanation: {
            bg: 'rgba(108, 92, 231, 0.03)',
            border: 'rgba(108, 92, 231, 0.2)',
            accent: '#6c5ce7',
            iconBg: 'rgba(108, 92, 231, 0.15)'
        },
        example: {
            bg: 'rgba(34, 197, 94, 0.03)',
            border: 'rgba(34, 197, 94, 0.2)',
            accent: '#22c55e',
            iconBg: 'rgba(34, 197, 94, 0.15)'
        },
        misconception: {
            bg: 'rgba(239, 68, 68, 0.03)',
            border: 'rgba(239, 68, 68, 0.2)',
            accent: '#ef4444',
            iconBg: 'rgba(239, 68, 68, 0.15)'
        },
        visual: {
            bg: 'rgba(6, 182, 212, 0.03)',
            border: 'rgba(6, 182, 212, 0.2)',
            accent: '#06b6d4',
            iconBg: 'rgba(6, 182, 212, 0.15)'
        },
        formula: {
            bg: 'rgba(245, 158, 11, 0.03)',
            border: 'rgba(245, 158, 11, 0.2)',
            accent: '#f59e0b',
            iconBg: 'rgba(245, 158, 11, 0.15)'
        },
    };

    if (loading) {
        return (
            <div className="animate-fade-in" style={{ textAlign: 'center', padding: '100px 20px' }}>
                <div style={{ marginBottom: '24px' }}>
                    <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" strokeWidth="1.5" style={{ animation: 'spin-slow 2s linear infinite' }}>
                        <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" strokeOpacity="0.2" />
                        <path d="M12 2a10 10 0 0110 10" />
                    </svg>
                </div>
                <h2 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '8px' }}>Crafting Knowledge Placards...</h2>
                <p style={{ color: 'var(--text-secondary)' }}>Our AI is organizing the document into simplified learning cards.</p>
            </div>
        );
    }

    if (error || !content) {
        return (
            <div className="animate-fade-in" style={{ textAlign: 'center', padding: '100px 20px' }}>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                    <AlertTriangle size={48} color="var(--accent-warning)" />
                </div>
                <h2 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '8px' }}>Oops!</h2>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>{error || 'Something went wrong'}</p>
                <button className="btn-primary" onClick={() => window.location.reload()}>Try Again</button>
            </div>
        );
    }

    return (
        <div className="animate-fade-in" style={{ maxWidth: '900px', margin: '0 auto', paddingBottom: '100px' }}>
            {/* Header */}
            <div style={{ marginBottom: '48px', textAlign: 'center' }}>
                <button className="btn-ghost" onClick={() => router.back()} style={{ marginBottom: '16px', display: 'inline-flex', alignItems: 'center', gap: '8px', margin: '0 auto 16px' }}>
                    <ArrowLeft size={16} /> Return to Journey
                </button>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <span className="badge badge-info" style={{ display: 'flex', width: 'fit-content', margin: '0 auto 12px', alignItems: 'center', gap: '8px' }}>
                        <Rocket size={14} /> Immersive Learning
                    </span>
                </div>
                <h1 style={{ fontSize: '2.8rem', fontWeight: 900, letterSpacing: '-0.03em', marginBottom: '8px' }}>
                    {content.title}
                </h1>
                <p style={{ color: 'var(--text-secondary)', fontSize: '1.1rem' }}>
                    Explore these placards to master the core concepts.
                </p>
            </div>

            {/* Knowledge Placards Grid/List */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
                {content.sections.map((section, idx) => {
                    const styles = sectionTypeStyles[section.type] || sectionTypeStyles.explanation;

                    return (
                        <div
                            key={idx}
                            className="glass-card animate-fade-in"
                            style={{
                                padding: '40px',
                                borderLeft: `8px solid ${styles.accent}`,
                                background: styles.bg,
                                position: 'relative',
                                display: 'grid',
                                gridTemplateColumns: '1fr',
                                gap: '40px',
                                alignItems: 'center',
                            }}
                        >
                            <div style={{ position: 'absolute', top: '20px', right: '30px', fontSize: '2rem', opacity: 0.1 }}>
                                {idx + 1}
                            </div>

                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
                                    <div style={{
                                        width: '48px',
                                        height: '48px',
                                        borderRadius: '12px',
                                        background: styles.iconBg,
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        color: styles.accent
                                    }}>
                                        <DynamicIcon name={section.icon} size={28} />
                                    </div>
                                    <h2 style={{ fontSize: '1.6rem', fontWeight: 800 }}>{section.heading}</h2>
                                </div>

                                <div style={{
                                    color: 'var(--text-primary)',
                                    fontSize: '1.1rem',
                                    lineHeight: 1.8,
                                    whiteSpace: 'pre-wrap',
                                }}>
                                    {section.content}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Mastery CTA */}
            <div className="glass-card animate-pulse-glow" style={{
                padding: '60px 40px',
                marginTop: '64px',
                textAlign: 'center',
                background: 'linear-gradient(135deg, rgba(108, 92, 231, 0.15), rgba(6, 182, 212, 0.15))',
                borderRadius: 'var(--radius-xl)',
                border: '1px solid var(--accent-primary)'
            }}>
                <h3 style={{ fontSize: '1.8rem', fontWeight: 900, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px', justifyContent: 'center' }}>
                    Assessment Unlocked! <Target size={28} className="text-primary" />
                </h3>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '40px', fontSize: '1.2rem', maxWidth: '600px', margin: '0 auto 40px' }}>
                    You&apos;ve explored all the knowledge placards. Are you ready to see how much you&apos;ve mastered?
                </p>
                <div style={{ display: 'flex', gap: '20px', justifyContent: 'center', flexWrap: 'wrap' }}>
                    <button className="btn-primary" onClick={() => router.push(`/dashboard/test/${conceptId}?mode=practice`)} style={{ padding: '18px 48px', fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <Pencil size={20} /> Practice Test
                    </button>
                    <button className="btn-secondary" onClick={() => router.push(`/dashboard/test/${conceptId}?mode=mastery`)} style={{ padding: '18px 48px', fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <Trophy size={20} /> Mastery Test
                    </button>
                </div>
            </div>
        </div>
    );
}

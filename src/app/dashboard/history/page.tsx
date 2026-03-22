'use client';

import { useRouter } from 'next/navigation';
import { 
  Search, 
  FileEdit, 
  Trophy, 
  Clock, 
  ClipboardList, 
  BarChart, 
  HelpCircle, 
  Target, 
  ChevronRight 
} from 'lucide-react';

const demoHistory = [
    {
        id: '1',
        concept: 'Photosynthesis',
        mode: 'diagnostic',
        score: 72,
        correct: 4,
        total: 5,
        date: '2026-02-19T10:30:00Z',
        duration: '3m 42s',
    },
    {
        id: '2',
        concept: 'Cell Structure',
        mode: 'mastery',
        score: 94,
        correct: 5,
        total: 5,
        date: '2026-02-18T14:20:00Z',
        duration: '4m 15s',
    },
    {
        id: '3',
        concept: 'States of Matter',
        mode: 'practice',
        score: 45,
        correct: 2,
        total: 5,
        date: '2026-02-17T09:10:00Z',
        duration: '5m 03s',
    },
    {
        id: '4',
        concept: 'Force & Motion',
        mode: 'spaced',
        score: 67,
        correct: 3,
        total: 5,
        date: '2026-02-16T16:45:00Z',
        duration: '3m 28s',
    },
    {
        id: '5',
        concept: 'Magnetism',
        mode: 'mastery',
        score: 91,
        correct: 5,
        total: 5,
        date: '2026-02-15T11:00:00Z',
        duration: '2m 56s',
    },
    {
        id: '6',
        concept: 'Photosynthesis',
        mode: 'practice',
        score: 60,
        correct: 3,
        total: 5,
        date: '2026-02-14T13:30:00Z',
        duration: '4m 50s',
    },
    {
        id: '7',
        concept: 'Chemical Reactions',
        mode: 'diagnostic',
        score: 28,
        correct: 1,
        total: 5,
        date: '2026-02-13T10:00:00Z',
        duration: '6m 12s',
    },
];

const modeIcons: Record<string, any> = {
    diagnostic: Search,
    practice: FileEdit,
    mastery: Trophy,
    spaced: Clock,
};

const modeColors: Record<string, string> = {
    diagnostic: '#06b6d4',
    practice: '#6c5ce7',
    mastery: '#22c55e',
    spaced: '#f59e0b',
};

export default function HistoryPage() {
    const router = useRouter();

    const totalTests = demoHistory.length;
    const avgScore = Math.round(demoHistory.reduce((sum, h) => sum + h.score, 0) / totalTests);
    const totalCorrect = demoHistory.reduce((sum, h) => sum + h.correct, 0);
    const totalQuestions = demoHistory.reduce((sum, h) => sum + h.total, 0);

    return (
        <div className="animate-fade-in">
            <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '8px' }}>
                Test History
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '1rem', marginBottom: '32px' }}>
                Review your past assessments and track your progress
            </p>

            {/* Summary Stats */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '16px',
                marginBottom: '32px',
            }}>
                {[
                    { label: 'Total Tests', value: totalTests, icon: <ClipboardList size={24} />, color: 'var(--accent-primary)' },
                    { label: 'Avg Score', value: `${avgScore}%`, icon: <BarChart size={24} />, color: 'var(--accent-tertiary)' },
                    { label: 'Questions Answered', value: totalQuestions, icon: <HelpCircle size={24} />, color: 'var(--accent-warning)' },
                    { label: 'Overall Accuracy', value: `${Math.round((totalCorrect / totalQuestions) * 100)}%`, icon: <Target size={24} />, color: 'var(--accent-success)' },
                ].map((stat, idx) => (
                    <div key={idx} className="stat-card" style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                        <div style={{ color: stat.color, marginBottom: '8px' }}>{stat.icon}</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 700, color: stat.color }}>
                            {stat.value}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>{stat.label}</div>
                    </div>
                ))}
            </div>

            {/* History List */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {demoHistory.map((item) => (
                    <div
                        key={item.id}
                        className="glass-card"
                        style={{
                            padding: '20px 24px',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            cursor: 'pointer',
                            flexWrap: 'wrap',
                            gap: '12px',
                        }}
                        onClick={() => router.push(`/dashboard/concept/${item.id}`)}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                            <div style={{
                                width: '44px',
                                height: '44px',
                                borderRadius: '12px',
                                background: `${modeColors[item.mode]}15`,
                                border: `1px solid ${modeColors[item.mode]}30`,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: modeColors[item.mode],
                            }}>
                                {(() => {
                                    const IconComponent = modeIcons[item.mode];
                                    return IconComponent ? <IconComponent size={20} /> : null;
                                })()}
                            </div>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: '1rem', marginBottom: '4px' }}>
                                    {item.concept}
                                </div>
                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                    <span className="badge" style={{
                                        background: `${modeColors[item.mode]}15`,
                                        color: modeColors[item.mode],
                                        border: `1px solid ${modeColors[item.mode]}30`,
                                        textTransform: 'capitalize',
                                    }}>
                                        {item.mode}
                                    </span>
                                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                        {new Date(item.date).toLocaleDateString('en-US', {
                                            month: 'short',
                                            day: 'numeric',
                                            hour: '2-digit',
                                            minute: '2-digit',
                                        })}
                                    </span>
                                </div>
                            </div>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
                            <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '2px' }}>Score</div>
                                <div style={{
                                    fontSize: '1.1rem',
                                    fontWeight: 700,
                                    color: item.score >= 85
                                        ? 'var(--accent-success)'
                                        : item.score >= 60
                                            ? 'var(--accent-primary)'
                                            : 'var(--accent-warning)',
                                }}>
                                    {item.score}%
                                </div>
                            </div>
                            <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '2px' }}>Correct</div>
                                <div style={{ fontSize: '1rem', fontWeight: 600 }}>{item.correct}/{item.total}</div>
                            </div>
                            <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '2px' }}>Time</div>
                                <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>{item.duration}</div>
                            </div>
                            <ChevronRight size={20} color="var(--text-muted)" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

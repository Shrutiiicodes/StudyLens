'use client';

import { Clock } from 'lucide-react';

interface ProgressCardProps {
    title: string;
    mastery: number;
    status: 'locked' | 'unlocked' | 'mastered';
    needsReview?: boolean;
    lastUpdated?: string;
    onClick?: () => void;
}

export default function ProgressCard({
    title,
    mastery,
    status,
    needsReview = false,
    lastUpdated,
    onClick,
}: ProgressCardProps) {
    const getStatusColor = () => {
        if (status === 'mastered') return 'var(--accent-success)';
        if (status === 'locked') return 'var(--accent-danger)';
        return 'var(--accent-primary)';
    };

    const getProgressGradient = () => {
        if (mastery >= 85) return 'var(--gradient-success)';
        if (mastery >= 60) return 'var(--gradient-primary)';
        if (mastery >= 30) return 'var(--gradient-secondary)';
        return 'var(--gradient-warm)';
    };

    const getStatusBadge = () => {
        if (status === 'mastered') return { text: 'MASTERED', class: 'badge-success' };
        if (status === 'locked') return { text: 'LOCKED', class: 'badge-danger' };
        return { text: 'IN PROGRESS', class: 'badge-info' };
    };

    const badge = getStatusBadge();

    return (
        <div
            className="glass-card"
            onClick={onClick}
            style={{
                padding: '24px',
                cursor: onClick ? 'pointer' : 'default',
                position: 'relative',
                overflow: 'hidden',
                transition: 'transform 0.2s ease, box-shadow 0.2s ease',
            }}
            onMouseOver={(e) => { if (onClick) (e.currentTarget as HTMLElement).style.transform = 'translateY(-4px)'; }}
            onMouseOut={(e) => { if (onClick) (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; }}
        >
            {/* Accent line */}
            <div style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: '3px',
                background: getProgressGradient(),
            }} />

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
                <div>
                    <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '6px' }}>
                        {title}
                    </h3>
                    {lastUpdated && (
                        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                            Last studied: {new Date(lastUpdated).toLocaleDateString()}
                        </p>
                    )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' }}>
                    <span className={`badge ${badge.class}`} style={{ fontSize: '0.7rem', fontWeight: 700 }}>{badge.text}</span>
                    {needsReview && (
                        <span className="badge badge-warning" style={{ fontSize: '0.7rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <Clock size={10} /> REVIEW
                        </span>
                    )}
                </div>
            </div>

            {/* Progress bar */}
            <div className="progress-bar" style={{ marginBottom: '12px' }}>
                <div
                    className="progress-bar-fill"
                    style={{
                        width: `${Math.max(2, mastery)}%`,
                        background: getProgressGradient(),
                    }}
                />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    Mastery Score
                </span>
                <span style={{
                    fontSize: '1.3rem',
                    fontWeight: 700,
                    color: getStatusColor(),
                }}>
                    {Math.round(mastery)}%
                </span>
            </div>
        </div>
    );
}

'use client';

/**
 * ReviewQueue.tsx
 *
 * "Review Today" dashboard widget.
 *
 * Reads the `reviewQueue` array returned by GET /api/mastery and renders
 * an actionable list of concepts the student should revisit before their
 * mastery decays below the lock threshold (70).
 *
 * Uses the forgetting-model fields added to the mastery API:
 *   • review_urgency       (0–1)
 *   • review_by_date       (ISO string)
 *   • review_days_remaining (number)
 *   • current_mastery      (number)
 *
 * Drop this component anywhere on the dashboard page:
 *   <ReviewQueue userId={user.id} />
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Clock, AlertTriangle, CheckCircle, ChevronRight, RefreshCw } from 'lucide-react';

interface ReviewItem {
    concept_id: string;
    concept_title: string;
    current_mastery: number;
    review_urgency: number;         // 0–1
    review_by_date: string;         // ISO
    review_days_remaining?: number; // convenience — may not be present for legacy data
}

interface Props {
    userId: string;
}

function urgencyColor(urgency: number): string {
    if (urgency >= 0.8) return 'var(--accent-danger, #ef4444)';
    if (urgency >= 0.5) return 'var(--accent-warning, #f59e0b)';
    return 'var(--accent-success, #22c55e)';
}

function urgencyLabel(urgency: number, daysRemaining: number): string {
    if (daysRemaining === 0) return 'Overdue — review now';
    if (urgency >= 0.8) return `Due in ${daysRemaining}d — urgent`;
    if (urgency >= 0.5) return `Due in ${daysRemaining}d`;
    return `Due in ${daysRemaining}d — on track`;
}

export default function ReviewQueue({ userId }: Props) {
    const [items, setItems] = useState<ReviewItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [reviewDueCount, setReviewDueCount] = useState(0);

    async function load() {
        setLoading(true);
        try {
            const res = await fetch(`/api/mastery?userId=${userId}`);
            const data = await res.json();
            if (data.success) {
                setItems(data.reviewQueue || []);
                setReviewDueCount(data.overview?.reviewDueCount || 0);
            }
        } catch (e) {
            console.error('[ReviewQueue] fetch error', e);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        if (userId) load();
    }, [userId]);

    if (loading) {
        return (
            <div className="glass-card" style={{ padding: '24px', textAlign: 'center' }}>
                <RefreshCw size={20} style={{ animation: 'spin 1s linear infinite', opacity: 0.5 }} />
            </div>
        );
    }

    if (items.length === 0) {
        return (
            <div
                className="glass-card"
                style={{
                    padding: '24px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    color: 'var(--accent-success)',
                }}
            >
                <CheckCircle size={20} />
                <span style={{ fontWeight: 500 }}>
                    All concepts are within their review window — great work!
                </span>
            </div>
        );
    }

    return (
        <div className="glass-card" style={{ padding: '24px' }}>
            {/* Header */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '20px',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <Clock size={20} style={{ color: 'var(--accent-warning, #f59e0b)' }} />
                    <h3 style={{ fontWeight: 700, fontSize: '1rem', margin: 0 }}>
                        Review Queue
                    </h3>
                    <span
                        style={{
                            background: 'var(--accent-danger, #ef4444)',
                            color: '#fff',
                            borderRadius: '999px',
                            padding: '2px 8px',
                            fontSize: '0.75rem',
                            fontWeight: 700,
                        }}
                    >
                        {reviewDueCount}
                    </span>
                </div>
                <button
                    onClick={load}
                    style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'var(--text-muted)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        fontSize: '0.8rem',
                    }}
                >
                    <RefreshCw size={14} /> Refresh
                </button>
            </div>

            {/* List */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {items.map((item) => {
                    const daysRemaining = item.review_days_remaining ?? 0;
                    const color = urgencyColor(item.review_urgency);
                    const label = urgencyLabel(item.review_urgency, daysRemaining);
                    const masteryPct = Math.round(item.current_mastery);

                    return (
                        <Link
                            key={item.concept_id}
                            href={`/dashboard/test/${item.concept_id}?mode=spaced&title=${encodeURIComponent(item.concept_title)}`}
                            style={{ textDecoration: 'none' }}
                        >
                            <div
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '14px',
                                    padding: '12px 16px',
                                    borderRadius: 'var(--radius-md)',
                                    background: 'var(--bg-elevated)',
                                    border: `1px solid ${color}33`,
                                    cursor: 'pointer',
                                    transition: 'background 0.15s ease',
                                }}
                                onMouseEnter={(e) =>
                                ((e.currentTarget as HTMLDivElement).style.background =
                                    'var(--bg-card)')
                                }
                                onMouseLeave={(e) =>
                                ((e.currentTarget as HTMLDivElement).style.background =
                                    'var(--bg-elevated)')
                                }
                            >
                                {/* Urgency dot */}
                                <div
                                    style={{
                                        width: '10px',
                                        height: '10px',
                                        borderRadius: '50%',
                                        background: color,
                                        flexShrink: 0,
                                    }}
                                />

                                {/* Concept info */}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <p
                                        style={{
                                            fontWeight: 600,
                                            fontSize: '0.9rem',
                                            margin: 0,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}
                                    >
                                        {item.concept_title}
                                    </p>
                                    <p
                                        style={{
                                            fontSize: '0.75rem',
                                            color: 'var(--text-muted)',
                                            margin: '2px 0 0',
                                        }}
                                    >
                                        {label}
                                    </p>
                                </div>

                                {/* Mastery badge */}
                                <div
                                    style={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        alignItems: 'flex-end',
                                        gap: '4px',
                                    }}
                                >
                                    <span
                                        style={{
                                            fontSize: '0.85rem',
                                            fontWeight: 700,
                                            color,
                                        }}
                                    >
                                        {masteryPct}%
                                    </span>
                                    {/* Mini decay bar */}
                                    <div
                                        style={{
                                            width: '60px',
                                            height: '4px',
                                            background: 'var(--bg-secondary)',
                                            borderRadius: '2px',
                                            overflow: 'hidden',
                                        }}
                                    >
                                        <div
                                            style={{
                                                width: `${masteryPct}%`,
                                                height: '100%',
                                                background: color,
                                                borderRadius: '2px',
                                                transition: 'width 0.5s ease',
                                            }}
                                        />
                                    </div>
                                </div>

                                <ChevronRight
                                    size={16}
                                    style={{ color: 'var(--text-muted)', flexShrink: 0 }}
                                />
                            </div>
                        </Link>
                    );
                })}
            </div>

            {/* Footer hint */}
            <p
                style={{
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)',
                    marginTop: '16px',
                    textAlign: 'center',
                }}
            >
                Concepts are sorted by review urgency. Click to start a spaced reinforcement session.
            </p>
        </div>
    );
}
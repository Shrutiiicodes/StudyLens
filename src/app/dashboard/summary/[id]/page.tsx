'use client';

import { useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { 
  CheckCircle, 
  ClipboardList, 
  Brain, 
  Pencil, 
  Link2, 
  PartyPopper, 
  FileEdit, 
  Trophy, 
  MessageSquareText, 
  Edit3, 
  ArrowLeft, 
  BarChart, 
  X, 
  RefreshCw, 
  Send 
} from 'lucide-react';

export default function SummaryPage() {
    const params = useParams();
    const router = useRouter();
    const searchParams = useSearchParams();
    const conceptId = params.id as string;
    const conceptTitle = searchParams.get('title') || 'Concept';

    const [summary, setSummary] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [result, setResult] = useState<{
        score: number;
        feedback: string;
        rubric: Record<string, number>;
        passed: boolean;
    } | null>(null);
    const [error, setError] = useState('');

    const handleSubmit = async () => {
        if (summary.trim().length < 50) {
            setError('Please write at least 50 characters.');
            return;
        }

        setSubmitting(true);
        setError('');

        try {
            const stored = localStorage.getItem('study-lens-user');
            const userId = stored ? JSON.parse(stored).id : null;

            const res = await fetch('/api/summary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId,
                    conceptId,
                    conceptTitle,
                    summary: summary.trim(),
                }),
            });

            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Evaluation failed');
            }

            setResult(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to evaluate summary');
        } finally {
            setSubmitting(false);
        }
    };

    const rubricLabels: Record<string, string> = {
        accuracy: 'Accuracy',
        completeness: 'Completeness',
        understanding: 'Understanding',
        clarity: 'Clarity',
        connections: 'Connections',
    };

    const rubricIcons: Record<string, any> = {
        accuracy: CheckCircle,
        completeness: ClipboardList,
        understanding: Brain,
        clarity: Pencil,
        connections: Link2,
    };

    // Results view
    if (result) {
        return (
            <div className="animate-fade-in" style={{ maxWidth: '700px', margin: '0 auto' }}>
                <div className="glass-card" style={{ padding: '40px', textAlign: 'center' }}>
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                        {result.passed ? <PartyPopper size={64} color="var(--accent-success)" /> : <FileEdit size={64} color="var(--accent-primary)" />}
                    </div>

                    <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '8px' }}>
                        {result.passed ? 'Great Summary!' : 'Keep Working!'}
                    </h1>

                    <p style={{ color: 'var(--text-secondary)', fontSize: '1.05rem', marginBottom: '32px' }}>
                        {result.passed
                            ? `You've demonstrated strong understanding of ${conceptTitle}. Concept complete!`
                            : `Your summary needs improvement. Try adding more detail about the key concepts.`}
                    </p>

                    {/* Score */}
                    <div style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '120px',
                        height: '120px',
                        borderRadius: '50%',
                        background: `conic-gradient(
                            ${result.passed ? 'var(--accent-success)' : 'var(--accent-warning)'}
                            ${result.score * 3.6}deg,
                            var(--bg-elevated) 0deg
                        )`,
                        marginBottom: '24px',
                        position: 'relative',
                    }}>
                        <div style={{
                            width: '100px',
                            height: '100px',
                            borderRadius: '50%',
                            background: 'var(--bg-secondary)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexDirection: 'column',
                        }}>
                            <span style={{ fontSize: '2rem', fontWeight: 800 }}>{result.score}</span>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>SCORE</span>
                        </div>
                    </div>

                    {/* Rubric */}
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                        gap: '12px',
                        marginBottom: '24px',
                        textAlign: 'left',
                    }}>
                        {(Object.entries(result.rubric) as [string, number][]).map(([key, value]) => {
                            const IconComponent = rubricIcons[key];
                            return (
                                <div key={key} className="stat-card" style={{ padding: '12px' }}>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        {IconComponent && <IconComponent size={12} />}
                                        {rubricLabels[key] || key}
                                    </div>
                                    <div style={{ display: 'flex', gap: '3px' }}>
                                        {[1, 2, 3, 4, 5].map((i) => (
                                            <div key={i} style={{
                                                width: '16px',
                                                height: '6px',
                                                borderRadius: '3px',
                                                background: i <= value ? 'var(--accent-primary)' : 'var(--bg-elevated)',
                                            }} />
                                        ))}
                                    </div>
                                    <div style={{ fontSize: '0.85rem', fontWeight: 600, marginTop: '4px' }}>{value}/5</div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Feedback */}
                    <div className="glass-card" style={{
                        padding: '16px',
                        marginBottom: '24px',
                        textAlign: 'left',
                        background: 'var(--bg-glass)',
                        display: 'flex',
                        gap: '12px',
                    }}>
                        <MessageSquareText size={20} color="var(--accent-primary)" style={{ flexShrink: 0, marginTop: '2px' }} />
                        <p style={{ fontSize: '0.9rem', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
                            {result.feedback}
                        </p>
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
                        {!result.passed && (
                            <button className="btn-primary" onClick={() => { setResult(null); }} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <Edit3 size={18} /> Try Again
                            </button>
                        )}
                        <button className="btn-secondary" onClick={() => router.push('/dashboard/concepts')} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <ArrowLeft size={18} /> Back to Concepts
                        </button>
                        <button className="btn-secondary" onClick={() => router.push('/dashboard')} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <BarChart size={18} /> Dashboard
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // Writing view
    return (
        <div className="animate-fade-in" style={{ maxWidth: '720px', margin: '0 auto' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                <div>
                    <span className="badge badge-info" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                        <Pencil size={14} /> Summary Assignment
                    </span>
                    <span style={{ marginLeft: '12px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                        {conceptTitle}
                    </span>
                </div>
                <button className="btn-ghost" onClick={() => router.back()} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <X size={16} /> Exit
                </button>
            </div>

            {/* Instructions */}
            <div className="glass-card" style={{ padding: '24px', marginBottom: '24px' }}>
                <h2 style={{ fontSize: '1.3rem', fontWeight: 600, marginBottom: '12px' }}>
                    Write Your Summary
                </h2>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: 1.6, marginBottom: '16px' }}>
                    In your own words, write a comprehensive summary of <strong>{conceptTitle}</strong>.
                    Explain the key concepts, definitions, and any important relationships you understood.
                </p>
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    {['Accuracy', 'Completeness', 'Understanding', 'Clarity', 'Connections'].map((r) => (
                        <span key={r} className="badge" style={{
                            background: 'var(--bg-elevated)',
                            color: 'var(--text-secondary)',
                            fontSize: '0.75rem',
                        }}>
                            {r}
                        </span>
                    ))}
                </div>
            </div>

            {/* Text area */}
            <div className="glass-card" style={{ padding: '24px', marginBottom: '20px' }}>
                <textarea
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    placeholder={`Write your summary of ${conceptTitle} here...\n\nTry to cover:\n- Key definitions and terms\n- Main concepts and how they relate\n- Any formulas or processes\n- Real-world examples\n- What you found most interesting`}
                    style={{
                        width: '100%',
                        minHeight: '300px',
                        padding: '16px',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-md)',
                        background: 'var(--bg-primary)',
                        color: 'var(--text-primary)',
                        fontSize: '0.95rem',
                        lineHeight: 1.7,
                        resize: 'vertical',
                        fontFamily: 'inherit',
                    }}
                />
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginTop: '12px',
                }}>
                    <span style={{
                        fontSize: '0.8rem',
                        color: summary.length < 50 ? 'var(--accent-warning)' : 'var(--text-muted)',
                    }}>
                        {summary.length} characters {summary.length < 50 ? '(minimum 50)' : <CheckCircle size={14} style={{ display: 'inline-block', verticalAlign: 'middle', marginLeft: '4px' }} />}
                    </span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        ~{Math.ceil(summary.split(/\s+/).filter(Boolean).length)} words
                    </span>
                </div>
            </div>

            {/* Error */}
            {error && (
                <div style={{
                    padding: '12px 16px',
                    borderRadius: 'var(--radius-md)',
                    background: 'rgba(255, 87, 87, 0.1)',
                    border: '1px solid rgba(255, 87, 87, 0.3)',
                    color: 'var(--accent-danger)',
                    marginBottom: '16px',
                    fontSize: '0.9rem',
                }}>
                    {error}
                </div>
            )}

            {/* Submit */}
            <div style={{ textAlign: 'center' }}>
                <button
                    className="btn-primary"
                    onClick={handleSubmit}
                    disabled={submitting || summary.trim().length < 50}
                    style={{
                        padding: '14px 32px',
                        fontSize: '1rem',
                        opacity: submitting || summary.trim().length < 50 ? 0.6 : 1,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '10px',
                        margin: '0 auto',
                    }}
                >
                    {submitting ? (
                        <><RefreshCw size={18} className="animate-spin" /> Evaluating...</>
                    ) : (
                        <><Send size={18} /> Submit Summary</>
                    )}
                </button>
            </div>
        </div>
    );
}

'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import QuestionCard from '@/components/QuestionCard';
import { Search, FileEdit, Trophy, AlertTriangle, Target, Library, BookOpen, RefreshCw, LayoutDashboard, X } from 'lucide-react';

interface QuestionData {
    id: string;
    text: string;
    options: string[];
    correct_answer: string;
    explanation: string;
    type: string;
    difficulty: number;
    concept_id: string;
    cognitive_level: number;
}

interface SessionMetrics {
    fas: number;
    wbs: number;
    ccms: number;
    mss: number;
    lip: number;
    rci_avg: number;
    calibration_error: number;
}

// ─── Metrics Panel ────────────────────────────────────────────────────────────

function MetricsPanel({ metrics }: { metrics: SessionMetrics | null }) {
    if (!metrics) return null;

    const items = [
        {
            key: 'fas' as keyof SessionMetrics,
            label: 'FAS',
            tooltip: 'Fractional Assessment Score — weights questions by type complexity',
            color: '#6c5ce7',
            isRaw: false,
        },
        {
            key: 'wbs' as keyof SessionMetrics,
            label: 'WBS',
            tooltip: "Weighted Bloom Score — weights correctness by Bloom's cognitive level",
            color: '#06b6d4',
            isRaw: false,
        },
        {
            key: 'ccms' as keyof SessionMetrics,
            label: 'CCMS',
            tooltip: 'Composite Confidence Mastery Score — combines FAS, WBS and raw score',
            color: '#22c55e',
            isRaw: false,
        },
        {
            key: 'mss' as keyof SessionMetrics,
            label: 'MSS',
            tooltip: 'Mastery Sensitivity Score — penalises confident-and-wrong answers (0–2)',
            color: '#f59e0b',
            isRaw: true,   // 0–2 scale, not 0–1
        },
        {
            key: 'lip' as keyof SessionMetrics,
            label: 'LIP',
            tooltip: 'Learning Improvement Priority — how urgently you should revisit this',
            color: '#ef4444',
            isRaw: false,
        },
        {
            key: 'calibration_error' as keyof SessionMetrics,
            label: 'Calibration Error',
            tooltip: 'How far your confidence is from actual accuracy — lower is better',
            color: '#a855f7',
            isRaw: false,
        },
    ];

    return (
        <div style={{ marginBottom: '24px' }}>
            <h3 style={{
                fontSize: '0.85rem',
                fontWeight: 600,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom: '12px',
                textAlign: 'left',
            }}>
                Session Metrics
            </h3>
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                gap: '10px',
            }}>
                {items.map(({ key, label, tooltip, color, isRaw }) => {
                    const raw = metrics[key] ?? 0;
                    const display = isRaw
                        ? raw.toFixed(2)
                        : `${Math.round(raw * 100)}%`;
                    const barPct = isRaw
                        ? Math.min(100, Math.round((raw / 2) * 100))
                        : Math.min(100, Math.round(raw * 100));

                    return (
                        <div
                            key={key}
                            title={tooltip}
                            className="stat-card"
                            style={{ padding: '12px', cursor: 'help' }}
                        >
                            <div style={{
                                fontSize: '0.7rem',
                                fontWeight: 600,
                                color: 'var(--text-muted)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.05em',
                                marginBottom: '6px',
                            }}>
                                {label}
                            </div>
                            <div style={{
                                fontSize: '1.1rem',
                                fontWeight: 700,
                                color,
                                marginBottom: '8px',
                            }}>
                                {display}
                            </div>
                            <div style={{
                                height: '4px',
                                background: 'var(--bg-elevated)',
                                borderRadius: '2px',
                                overflow: 'hidden',
                            }}>
                                <div style={{
                                    width: `${barPct}%`,
                                    height: '100%',
                                    background: color,
                                    borderRadius: '2px',
                                    transition: 'width 0.8s cubic-bezier(0.4,0,0.2,1)',
                                }} />
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function TestPage() {
    const params = useParams();
    const router = useRouter();
    const searchParams = useSearchParams();
    const conceptId = params.id as string;
    const mode = searchParams.get('mode') || 'diagnostic';

    const [questions, setQuestions] = useState<QuestionData[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [currentIndex, setCurrentIndex] = useState(0);
    const [results, setResults] = useState<Array<{ correct: boolean; timeTaken: number; confidence: number }>>([]);
    const [showResult, setShowResult] = useState(false);
    const [testComplete, setTestComplete] = useState(false);
    const [conceptTitle, setConceptTitle] = useState('');
    const [recommendedPath, setRecommendedPath] = useState<'test_it' | 'learn_it'>('learn_it');
    const [evaluating, setEvaluating] = useState(false);
    const [passed, setPassed] = useState(false);
    const [nextStage, setNextStage] = useState('');


    useEffect(() => {
        const title = searchParams.get('title') || '';
        setConceptTitle(title);
    }, [conceptId, searchParams]);

    useEffect(() => {
        async function fetchQuestions() {
            // Reset test state for new session
            setTestComplete(false);
            setResults([]);
            setCurrentIndex(0);
            setShowResult(false);
            setEvaluating(false);
            setPassed(false);

            setLoading(true);
            setError('');
            const title = searchParams.get('title') || '';

            try {
                const stored = localStorage.getItem('study-lens-user');
                const userId = stored ? JSON.parse(stored).id : null;

                const res = await fetch('/api/diagnostic', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'generate',
                        conceptId,
                        conceptTitle: title,
                        mode,
                        userId, // Pass user boundary for spaced repetition graph lookups
                    }),
                });

                const data = await res.json();

                if (!res.ok || !data.success) {
                    throw new Error(data.error || 'Failed to generate questions');
                }

                if (data.questions && data.questions.length > 0) {
                    setQuestions(data.questions);
                } else {
                    throw new Error('No questions were generated');
                }
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to generate questions.');
            } finally {
                setLoading(false);
            }
        }

        fetchQuestions();
    }, [conceptId, searchParams]);

    const currentQuestion = questions[currentIndex];

    const handleAnswer = (answer: string, timeTaken: number, confidence: number) => {
        if (!currentQuestion) return;
        const correct = answer === currentQuestion.correct_answer;
        setResults((prev) => [...prev, { correct, timeTaken, confidence }]);
        setShowResult(true);
    };

    const handleNext = async () => {
        if (currentIndex < questions.length - 1) {
            setCurrentIndex((prev) => prev + 1);
            setShowResult(false);
        } else {
            setTestComplete(true);

            try {
                setEvaluating(true);
                const stored = localStorage.getItem('study-lens-user');
                const userId = stored ? JSON.parse(stored).id : null;

                if (userId) {
                    const questionResults = questions.map((q, i) => ({
                        question_id: q.id,
                        correct: results[i]?.correct ?? false,
                        difficulty: q.difficulty,
                        cognitive_level: q.cognitive_level,
                        time_taken: results[i]?.timeTaken ?? 0,
                        confidence: results[i]?.confidence ?? 0.5,
                        concept_id: q.concept_id,
                    }));

                    const evalRes = await fetch('/api/diagnostic', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            action: 'evaluate',
                            userId,
                            conceptId,
                            results: questionResults,
                            mode,
                        }),
                    });

                    const evalData = await evalRes.json();
                    if (evalData.success) {
                        setRecommendedPath(evalData.recommendedPath || 'learn_it');
                        setPassed(evalData.passed || false);
                        setNextStage(evalData.nextStage || '');

                    }
                }
            } catch (err) {
                console.error('Failed to submit results:', err);
            } finally {
                setEvaluating(false);
            }
        }
    };

    const correctCount = results.filter((r) => r.correct).length;
    const totalTime = results.reduce((sum, r) => sum + r.timeTaken, 0);
    const avgConfidence =
        results.length > 0
            ? results.reduce((sum, r) => sum + r.confidence, 0) / results.length
            : 0;
    const scorePercent =
        results.length > 0 ? Math.round((correctCount / results.length) * 100) : 0;

    const modeLabels: Record<string, React.ReactNode> = {
        diagnostic: <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Search size={16} /> Diagnostic Test</div>,
        practice: <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><FileEdit size={16} /> Practice Mode</div>,
        mastery: <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Trophy size={16} /> Mastery Test</div>,
    };

    // ── Loading ───────────────────────────────────────────────────────────
    if (loading) {
        return (
            <div className="animate-fade-in" style={{ maxWidth: '700px', margin: '0 auto' }}>
                <div className="glass-card" style={{ padding: '60px 40px', textAlign: 'center' }}>
                    <div style={{
                        width: '60px', height: '60px',
                        border: '3px solid var(--border-subtle)',
                        borderTop: '3px solid var(--accent-primary)',
                        borderRadius: '50%',
                        animation: 'spin-slow 1s linear infinite',
                        margin: '0 auto 24px',
                    }} />
                    <h2 style={{ fontSize: '1.4rem', fontWeight: 600, marginBottom: '12px' }}>
                        Generating Questions...
                    </h2>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
                        AI is creating personalised questions. This may take 15–30 seconds.
                    </p>
                </div>
            </div>
        );
    }

    // ── Error ─────────────────────────────────────────────────────────────
    if (error) {
        return (
            <div className="animate-fade-in" style={{ maxWidth: '700px', margin: '0 auto' }}>
                <div className="glass-card" style={{ padding: '40px', textAlign: 'center' }}>
                    <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'center', color: 'var(--accent-warning)' }}>
                        <AlertTriangle size={48} />
                    </div>
                    <h2 style={{ fontSize: '1.4rem', fontWeight: 600, marginBottom: '12px' }}>
                        Question Generation Failed
                    </h2>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>{error}</p>
                    <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                        <button className="btn-primary" onClick={() => window.location.reload()} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <RefreshCw size={18} /> Try Again
                        </button>
                        <button className="btn-secondary" onClick={() => router.back()}>
                            ← Go Back
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // ── Evaluating State ────────────────────────────────────────────────────
    if (evaluating) {
        return (
            <div className="animate-fade-in" style={{ maxWidth: '700px', margin: '0 auto' }}>
                <div className="glass-card" style={{ padding: '60px 40px', textAlign: 'center' }}>
                    <div style={{
                        width: '60px', height: '60px',
                        border: '3px solid var(--border-subtle)',
                        borderTop: '3px solid var(--accent-primary)',
                        borderRadius: '50%',
                        animation: 'spin-slow 1s linear infinite',
                        margin: '0 auto 24px',
                    }} />
                    <h2 style={{ fontSize: '1.4rem', fontWeight: 600, marginBottom: '12px' }}>
                        Evaluating Results...
                    </h2>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
                        Saving your progress and updating your mastery level...
                    </p>
                </div>
            </div>
        );
    }

    // ── Results screen ────────────────────────────────────────────────────
    if (testComplete) {
        return (
            <div className="animate-fade-in" style={{ maxWidth: '700px', margin: '0 auto' }}>
                <div className="glass-card" style={{ padding: '40px', textAlign: 'center' }}>
                    <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'center', color: scorePercent >= 85 ? 'var(--accent-success)' : scorePercent >= 60 ? 'var(--accent-primary)' : 'var(--accent-tertiary)' }}>
                        {scorePercent >= 85 ? <Trophy size={64} /> : scorePercent >= 60 ? <Target size={64} /> : <Library size={64} />}
                    </div>

                    <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '8px' }}>
                        {scorePercent >= 85
                            ? 'Excellent!'
                            : scorePercent >= 60
                                ? 'Good job!'
                                : 'Keep practising!'}
                    </h1>

                    <p style={{ color: 'var(--text-secondary)', fontSize: '1.05rem', marginBottom: '32px' }}>
                        {passed
                            ? nextStage
                                ? `Stage unlocked: ${nextStage}`
                                : 'Great work!'
                            : 'You need 60% to pass. Try again to advance.'}
                    </p>

                    {/* Score circle */}
                    <div style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '120px',
                        height: '120px',
                        borderRadius: '50%',
                        background: `conic-gradient(
                            ${scorePercent >= 85
                                ? 'var(--accent-success)'
                                : scorePercent >= 60
                                    ? 'var(--accent-primary)'
                                    : 'var(--accent-warning)'}
                            ${scorePercent * 3.6}deg,
                            var(--bg-elevated) 0deg
                        )`,
                        marginBottom: '24px',
                        position: 'relative',
                    }}>
                        <div style={{
                            width: '100px', height: '100px', borderRadius: '50%',
                            background: 'var(--bg-secondary)',
                            display: 'flex', alignItems: 'center',
                            justifyContent: 'center', flexDirection: 'column',
                        }}>
                            <span style={{ fontSize: '2rem', fontWeight: 800 }}>{scorePercent}</span>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>SCORE</span>
                        </div>
                    </div>

                    {/* Basic stats */}
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, 1fr)',
                        gap: '16px',
                        marginBottom: '28px',
                    }}>
                        <div className="stat-card" style={{ padding: '16px' }}>
                            <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--accent-success)' }}>
                                {correctCount}/{questions.length}
                            </div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Correct</div>
                        </div>
                        <div className="stat-card" style={{ padding: '16px' }}>
                            <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--accent-tertiary)' }}>
                                {totalTime}s
                            </div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Total Time</div>
                        </div>
                        <div className="stat-card" style={{ padding: '16px' }}>
                            <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--accent-primary)' }}>
                                {Math.round(avgConfidence * 100)}%
                            </div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Avg Confidence</div>
                        </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
                        <button
                            className="btn-secondary"
                            onClick={() => router.push(`/dashboard/learn/${conceptId}`)}
                            style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                        >
                            <BookOpen size={18} /> Learn It
                        </button>

                        {passed && nextStage && (
                            <button
                                className="btn-primary"
                                onClick={() =>
                                    router.push(
                                        `/dashboard/test/${conceptId}?mode=${nextStage}&title=${encodeURIComponent(conceptTitle)}`
                                    )
                                }
                            >
                                Next: {nextStage.charAt(0).toUpperCase() + nextStage.slice(1)}
                            </button>
                        )}

                        {!passed && (
                            <button
                                className="btn-primary"
                                onClick={() => {
                                    setTestComplete(false);
                                    setResults([]);
                                    setCurrentIndex(0);
                                    setShowResult(false);
                                    setQuestions([]);
                                    setLoading(true);
                                    fetch('/api/diagnostic', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            action: 'generate',
                                            conceptId,
                                            conceptTitle,
                                            mode,
                                        }),
                                    })
                                        .then((r) => r.json())
                                        .then((data) => {
                                            if (data.success && data.questions?.length > 0) {
                                                setQuestions(data.questions);
                                            }
                                            setLoading(false);
                                        })
                                        .catch(() => setLoading(false));
                                }}
                                style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                            >
                                <RefreshCw size={18} /> Retry
                            </button>
                        )}

                        <button
                            className="btn-secondary"
                            onClick={() => router.push('/dashboard/concepts')}
                        >
                            ← Back to Concepts
                        </button>
                        <button
                            className="btn-secondary"
                            onClick={() => router.push('/dashboard')}
                            style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                        >
                            <LayoutDashboard size={18} /> Dashboard
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (!currentQuestion) return null;

    // ── Active question ───────────────────────────────────────────────────
    return (
        <div className="animate-fade-in" style={{ maxWidth: '720px', margin: '0 auto' }}>
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '24px',
            }}>
                <div>
                    <span className="badge badge-info">{modeLabels[mode]}</span>
                    {conceptTitle && (
                        <span style={{ marginLeft: '12px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                            {conceptTitle}
                        </span>
                    )}
                </div>
                <button className="btn-ghost" onClick={() => router.back()} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <X size={16} /> Exit
                </button>
            </div>

            <QuestionCard
                question={currentQuestion}
                onAnswer={handleAnswer}
                showResult={showResult}
                questionNumber={currentIndex + 1}
                totalQuestions={questions.length}
            />

            {showResult && (
                <div className="animate-fade-in" style={{ textAlign: 'center', marginTop: '20px' }}>
                    <button className="btn-primary" onClick={handleNext}>
                        {currentIndex < questions.length - 1 ? 'Next Question →' : 'View Results'}
                    </button>
                </div>
            )}
        </div>
    );
}
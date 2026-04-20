'use client';
import { PASS_THRESHOLD } from '@/config/constants';

import { useState, useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import QuestionCard from '@/components/QuestionCard';
import { Search, FileEdit, Trophy, AlertTriangle, Target, Library, BookOpen, RefreshCw, LayoutDashboard, TrendingUp, Activity, Gauge, Zap, ChevronDown, ChevronUp } from 'lucide-react';

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
    is_spaced?: boolean;
}

// Updated interface — standard ITS metrics added
interface SessionMetrics {
    // Legacy custom metrics
    fas: number;
    wbs: number;
    ccms: number;
    mss: number;
    lip: number;
    rci_avg: number;
    calibration_error: number;
    // Standard ITS metrics (primary display)
    nlg: number;
    brier_score: number;
    ece: number;
    log_loss: number;
}

// ─── NLG Badge ───────────────────────────────────────────────────────────────

function NLGBadge({ nlg }: { nlg: number }) {
    // Hake (1998) classification: <0.3 low, 0.3–0.7 medium, >0.7 high gain
    const pct = Math.round(nlg * 100);
    const isNegative = nlg < 0;
    const label = nlg >= 0.7 ? 'High Gain' : nlg >= 0.3 ? 'Medium Gain' : nlg >= 0 ? 'Low Gain' : 'Regression';
    const color = nlg >= 0.7 ? '#22c55e' : nlg >= 0.3 ? '#06b6d4' : nlg >= 0 ? '#f59e0b' : '#ef4444';
    const bg = nlg >= 0.7 ? 'rgba(34,197,94,0.1)' : nlg >= 0.3 ? 'rgba(6,182,212,0.1)' : nlg >= 0 ? 'rgba(245,158,11,0.1)' : 'rgba(239,68,68,0.1)';

    return (
        <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 12px',
            borderRadius: '100px',
            background: bg,
            border: `1px solid ${color}40`,
            fontSize: '0.8rem',
            fontWeight: 600,
            color,
        }}>
            <TrendingUp size={13} />
            {isNegative ? `−${Math.abs(pct)}%` : `+${pct}%`} NLG · {label}
        </div>
    );
}

// ─── Primary ITS Metrics Panel ────────────────────────────────────────────────

function PrimaryMetricsPanel({ metrics }: { metrics: SessionMetrics }) {
    const primaryItems = [
        {
            icon: <TrendingUp size={20} />,
            label: 'Learning Gain',
            sublabel: 'NLG — Hake (1998)',
            value: (() => {
                const pct = Math.round(metrics.nlg * 100);
                return metrics.nlg >= 0 ? `+${pct}%` : `${pct}%`;
            })(),
            rawValue: metrics.nlg,
            tooltip: 'Normalized Learning Gain: (post − pre) / (100 − pre). Measures how much you actually improved relative to your headroom. Standard metric in STEM education research.',
            color: metrics.nlg >= 0.3 ? '#22c55e' : metrics.nlg >= 0 ? '#f59e0b' : '#ef4444',
            barPct: Math.max(0, Math.min(100, Math.round(metrics.nlg * 100))),
            higherIsBetter: true,
        },
        {
            icon: <Gauge size={20} />,
            label: 'Calibration Error',
            sublabel: 'ECE — Guo et al. (2017)',
            value: `${Math.round(metrics.ece * 100)}%`,
            rawValue: metrics.ece,
            tooltip: 'Expected Calibration Error: how well your confidence matches your actual accuracy. Lower is better. 0% = perfectly calibrated.',
            color: metrics.ece < 0.1 ? '#22c55e' : metrics.ece < 0.25 ? '#f59e0b' : '#ef4444',
            barPct: Math.min(100, Math.round(metrics.ece * 100)),
            higherIsBetter: false,
        },
        {
            icon: <Activity size={20} />,
            label: 'Confidence Quality',
            sublabel: 'Brier Score (Brier, 1950)',
            value: metrics.brier_score.toFixed(3),
            rawValue: metrics.brier_score,
            tooltip: 'Brier Score: average squared error between your confidence and the correct outcome. Lower is better. Penalises confident-wrong answers more than uncertain-wrong answers.',
            color: metrics.brier_score < 0.15 ? '#22c55e' : metrics.brier_score < 0.3 ? '#f59e0b' : '#ef4444',
            barPct: Math.min(100, Math.round(metrics.brier_score * 100)),
            higherIsBetter: false,
        },
        {
            icon: <Zap size={20} />,
            label: 'Prediction Quality',
            sublabel: 'Log-Loss (AUC-ROC proxy)',
            value: metrics.log_loss.toFixed(3),
            rawValue: metrics.log_loss,
            tooltip: 'Log-Loss (cross-entropy): measures how well your confidence predicts correctness on each question. Lower is better. Used in knowledge tracing research as a per-session proxy for AUC-ROC.',
            color: metrics.log_loss < 0.4 ? '#22c55e' : metrics.log_loss < 0.7 ? '#f59e0b' : '#ef4444',
            barPct: Math.min(100, Math.round((metrics.log_loss / 1.5) * 100)),
            higherIsBetter: false,
        },
    ];

    return (
        <div style={{ marginBottom: '24px' }}>
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '12px',
            }}>
                <h3 style={{
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    color: 'var(--text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                }}>
                    Session Metrics
                </h3>
                <span style={{
                    fontSize: '0.7rem',
                    color: 'var(--text-muted)',
                    padding: '2px 8px',
                    borderRadius: '100px',
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-subtle)',
                }}>
                    Standard ITS
                </span>
            </div>

            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: '10px',
            }}>
                {primaryItems.map(({ icon, label, sublabel, value, tooltip, color, barPct, higherIsBetter }) => (
                    <div
                        key={label}
                        title={tooltip}
                        className="stat-card"
                        style={{ padding: '14px', cursor: 'help' }}
                    >
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            color,
                            marginBottom: '8px',
                        }}>
                            {icon}
                            <span style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                {label}
                            </span>
                        </div>
                        <div style={{ fontSize: '1.3rem', fontWeight: 700, color, marginBottom: '2px' }}>
                            {value}
                        </div>
                        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '8px' }}>
                            {sublabel} · {higherIsBetter ? '↑ higher is better' : '↓ lower is better'}
                        </div>
                        <div style={{ height: '3px', background: 'var(--bg-elevated)', borderRadius: '2px', overflow: 'hidden' }}>
                            <div style={{
                                width: `${barPct}%`,
                                height: '100%',
                                background: color,
                                borderRadius: '2px',
                                transition: 'width 0.8s cubic-bezier(0.4,0,0.2,1)',
                            }} />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ─── Legacy Metrics Panel (collapsible) ──────────────────────────────────────

function LegacyMetricsPanel({ metrics }: { metrics: SessionMetrics }) {
    const [open, setOpen] = useState(false);

    const items = [
        { key: 'fas' as keyof SessionMetrics, label: 'FAS', tooltip: 'Fractional Assessment Score — weights questions by type complexity', color: '#6c5ce7', isRaw: false },
        { key: 'wbs' as keyof SessionMetrics, label: 'WBS', tooltip: "Weighted Bloom Score — weights correctness by Bloom's cognitive level", color: '#06b6d4', isRaw: false },
        { key: 'ccms' as keyof SessionMetrics, label: 'CCMS', tooltip: 'Composite Confidence Mastery Score — combines FAS, WBS and raw score', color: '#22c55e', isRaw: false },
        { key: 'mss' as keyof SessionMetrics, label: 'MSS', tooltip: 'Mastery Sensitivity Score — penalises confident-and-wrong answers (0–2)', color: '#f59e0b', isRaw: true },
        { key: 'lip' as keyof SessionMetrics, label: 'LIP', tooltip: 'Learning Improvement Priority — how urgently you should revisit this', color: '#ef4444', isRaw: false },
        { key: 'calibration_error' as keyof SessionMetrics, label: 'Calibration Error (raw)', tooltip: 'Average |correct − confidence| per attempt', color: '#a855f7', isRaw: false },
    ];

    return (
        <div style={{ marginBottom: '24px' }}>
            <button
                onClick={() => setOpen((o) => !o)}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-muted)',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    padding: '0 0 12px 0',
                }}
            >
                {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                Legacy Metrics (CCMS, FAS, WBS…)
            </button>

            {open && (
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                    gap: '10px',
                    animation: 'fade-in 0.2s ease',
                }}>
                    {items.map(({ key, label, tooltip, color, isRaw }) => {
                        const raw = (metrics[key] as number) ?? 0;
                        const display = isRaw ? raw.toFixed(2) : `${Math.round(raw * 100)}%`;
                        const barPct = isRaw
                            ? Math.min(100, Math.round((raw / 2) * 100))
                            : Math.min(100, Math.round(raw * 100));

                        return (
                            <div key={key} title={tooltip} className="stat-card" style={{ padding: '12px', cursor: 'help' }}>
                                <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
                                    {label}
                                </div>
                                <div style={{ fontSize: '1.1rem', fontWeight: 700, color, marginBottom: '8px' }}>
                                    {display}
                                </div>
                                <div style={{ height: '4px', background: 'var(--bg-elevated)', borderRadius: '2px', overflow: 'hidden' }}>
                                    <div style={{ width: `${barPct}%`, height: '100%', background: color, borderRadius: '2px', transition: 'width 0.8s cubic-bezier(0.4,0,0.2,1)' }} />
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ─── Combined Metrics Panel ───────────────────────────────────────────────────

function MetricsPanel({ metrics }: { metrics: SessionMetrics | null }) {
    if (!metrics) return null;
    return (
        <>
            <PrimaryMetricsPanel metrics={metrics} />
            <LegacyMetricsPanel metrics={metrics} />
        </>
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
    const [results, setResults] = useState<Array<{ correct: boolean; timeTaken: number; confidence: number; selectedAnswer: string }>>([]);
    const [showResult, setShowResult] = useState(false);
    const [testComplete, setTestComplete] = useState(false);
    const [conceptTitle, setConceptTitle] = useState('');
    const [recommendedPath, setRecommendedPath] = useState<'test_it' | 'learn_it'>('learn_it');
    const [evaluating, setEvaluating] = useState(false);
    const [passed, setPassed] = useState(false);
    const [nextStage, setNextStage] = useState('');
    const [sessionMetrics, setSessionMetrics] = useState<SessionMetrics | null>(null);

    useEffect(() => {
        const title = searchParams.get('title') || '';
        setConceptTitle(title);
    }, [conceptId, searchParams]);

    useEffect(() => {
        async function fetchQuestions() {
            setTestComplete(false);
            setResults([]);
            setCurrentIndex(0);
            setShowResult(false);
            setEvaluating(false);
            setPassed(false);
            setSessionMetrics(null);

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
                        userId,
                        mode,
                    }),
                });

                const data = await res.json();
                if (data.success && data.questions?.length > 0) {
                    setQuestions(data.questions);
                } else {
                    setError(data.error || 'No questions generated. Please try again.');
                }
            } catch {
                setError('Failed to load questions. Please check your connection.');
            } finally {
                setLoading(false);
            }
        }

        fetchQuestions();
    }, [conceptId, mode, searchParams]);

    const handleAnswer = (answer: string, timeTaken: number, confidence: number) => {
        // QuestionCard passes the selected answer string; derive correctness here
        const currentQuestion = questions[currentIndex];
        const correct = answer === currentQuestion?.correct_answer;
        setResults((prev) => [...prev, { correct, timeTaken, confidence, selectedAnswer: answer }]);
        setShowResult(true);
    };

    const handleNext = async () => {
        setShowResult(false);
        if (currentIndex < questions.length - 1) {
            setCurrentIndex((i) => i + 1);
        } else {
            setTestComplete(true);
            setEvaluating(true);

            try {
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
                        question_text: q.text,
                        selected_answer: results[i]?.selectedAnswer ?? '',
                        correct_answer: q.correct_answer,
                        explanation: q.explanation,
                        is_spaced: q.is_spaced ?? false,
                        question_type: q.type
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
                        // Capture standard ITS metrics from API response
                        if (evalData.metrics) {
                            setSessionMetrics(evalData.metrics);
                        }
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
        diagnostic: <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Search size={16} /> Easy 5</div>,
        practice: <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><FileEdit size={16} /> Practice Test</div>,
        mastery: <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Trophy size={16} /> Mastery Test</div>,
    };

    // ── Loading ───────────────────────────────────────────────────────────
    if (loading) {
        return (
            <div className="animate-fade-in" style={{ maxWidth: '700px', margin: '0 auto' }}>
                <div className="glass-card" style={{ padding: '60px 40px', textAlign: 'center' }}>
                    <div style={{ width: '60px', height: '60px', border: '3px solid var(--border-subtle)', borderTop: '3px solid var(--accent-primary)', borderRadius: '50%', animation: 'spin-slow 1s linear infinite', margin: '0 auto 24px' }} />
                    <h2 style={{ fontSize: '1.4rem', fontWeight: 600, marginBottom: '12px' }}>Generating Questions...</h2>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>Creating personalised questions. This may take 15–30 seconds.</p>
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
                    <h2 style={{ fontSize: '1.4rem', fontWeight: 600, marginBottom: '12px' }}>Question Generation Failed</h2>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>{error}</p>
                    <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                        <button className="btn-primary" onClick={() => window.location.reload()} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <RefreshCw size={18} /> Try Again
                        </button>
                        <button className="btn-secondary" onClick={() => router.back()}>← Go Back</button>
                    </div>
                </div>
            </div>
        );
    }

    // ── Evaluating ────────────────────────────────────────────────────────
    if (evaluating) {
        return (
            <div className="animate-fade-in" style={{ maxWidth: '700px', margin: '0 auto' }}>
                <div className="glass-card" style={{ padding: '60px 40px', textAlign: 'center' }}>
                    <div style={{ width: '60px', height: '60px', border: '3px solid var(--border-subtle)', borderTop: '3px solid var(--accent-primary)', borderRadius: '50%', animation: 'spin-slow 1s linear infinite', margin: '0 auto 24px' }} />
                    <h2 style={{ fontSize: '1.4rem', fontWeight: 600, marginBottom: '12px' }}>Evaluating Results...</h2>
                    {/* <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>Computing your learning gain and calibration metrics...</p> */}
                </div>
            </div>
        );
    }

    // ── Results ───────────────────────────────────────────────────────────
    if (testComplete) {
        return (
            <div className="animate-fade-in" style={{ maxWidth: '700px', margin: '0 auto' }}>
                <div className="glass-card" style={{ padding: '40px' }}>

                    {/* Header */}
                    <div style={{ textAlign: 'center', marginBottom: '32px' }}>
                        <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'center', color: scorePercent >= 85 ? 'var(--accent-success)' : scorePercent >= PASS_THRESHOLD ? 'var(--accent-primary)' : 'var(--accent-tertiary)' }}>
                            {scorePercent >= 85 ? <Trophy size={56} /> : scorePercent >= PASS_THRESHOLD ? <Target size={56} /> : <Library size={56} />}
                        </div>

                        <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '8px' }}>
                            {scorePercent >= 85 ? 'Excellent!' : scorePercent >= PASS_THRESHOLD ? 'Good job!' : 'Keep practising!'}
                        </h1>

                        <p style={{ color: 'var(--text-secondary)', fontSize: '1.05rem', marginBottom: '16px' }}>
                            {passed
                                ? nextStage ? `Stage unlocked: ${nextStage}` : 'Great work!'
                                : `You need ${PASS_THRESHOLD}% to pass. Try again to advance.`}
                        </p>

                        {/* NLG Badge — most prominent display of learning gain */}
                        {sessionMetrics && <NLGBadge nlg={sessionMetrics.nlg} />}
                    </div>

                    {/* Score circle + stats */}
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '32px' }}>
                        <div style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: '120px',
                            height: '120px',
                            borderRadius: '50%',
                            background: `conic-gradient(
                                ${scorePercent >= 85 ? 'var(--accent-success)' : scorePercent >= PASS_THRESHOLD ? 'var(--accent-primary)' : '#f59e0b'} ${scorePercent * 3.6}deg,
                                var(--bg-elevated) 0deg
                            )`,
                            position: 'relative',
                        }}>
                            <div style={{ position: 'absolute', inset: '10px', borderRadius: '50%', background: 'var(--bg-card)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                                <span style={{ fontSize: '1.5rem', fontWeight: 800 }}>{scorePercent}%</span>
                                <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{correctCount}/{results.length}</span>
                            </div>
                        </div>
                    </div>

                    {/* Quick stats */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '32px' }}>
                        <div className="stat-card" style={{ padding: '16px', textAlign: 'center' }}>
                            <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--accent-success)' }}>{correctCount}/{results.length}</div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Correct</div>
                        </div>
                        <div className="stat-card" style={{ padding: '16px', textAlign: 'center' }}>
                            <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--accent-primary)' }}>{Math.round(totalTime)}s</div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Total Time</div>
                        </div>
                        <div className="stat-card" style={{ padding: '16px', textAlign: 'center' }}>
                            <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--accent-primary)' }}>{Math.round(avgConfidence * 100)}%</div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Avg Confidence</div>
                        </div>
                    </div>

                    {/* Metrics panels */}
                    {/* <MetricsPanel metrics={sessionMetrics} /> */}

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
                        <button className="btn-secondary" onClick={() => router.push(`/dashboard/learn/${conceptId}`)} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <BookOpen size={18} /> Learn It
                        </button>

                        {passed && nextStage && (
                            <button className="btn-primary" onClick={() => router.push(`/dashboard/test/${conceptId}?mode=${nextStage}&title=${encodeURIComponent(conceptTitle)}`)}>
                                Next: {nextStage.charAt(0).toUpperCase() + nextStage.slice(1)}
                            </button>
                        )}

                        {!passed && (
                            <button className="btn-primary" onClick={() => {
                                setTestComplete(false);
                                setResults([]);
                                setCurrentIndex(0);
                                setShowResult(false);
                                setSessionMetrics(null);
                            }} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <RefreshCw size={18} /> Try Again
                            </button>
                        )}

                        <button className="btn-ghost" onClick={() => router.push('/dashboard')} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <LayoutDashboard size={18} /> Dashboard
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // ── Active test ───────────────────────────────────────────────────────
    const currentQuestion = questions[currentIndex];

    return (
        <div className="animate-fade-in" style={{ maxWidth: '700px', margin: '0 auto' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
                <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                        <div style={{
                            padding: '4px 12px',
                            borderRadius: '100px',
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border-subtle)',
                            fontSize: '0.8rem',
                            fontWeight: 600,
                            color: 'var(--accent-primary)',
                        }}>
                            {modeLabels[mode] || mode}
                        </div>
                    </div>
                    <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                        {conceptTitle || 'Assessment'}
                    </h2>
                </div>

                <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                    {currentIndex + 1} / {questions.length}
                </div>
            </div>

            {/* Progress bar */}
            <div style={{ height: '4px', background: 'var(--bg-elevated)', borderRadius: '2px', marginBottom: '24px', overflow: 'hidden' }}>
                <div style={{
                    width: `${((currentIndex + (showResult ? 1 : 0)) / questions.length) * 100}%`,
                    height: '100%',
                    background: 'var(--gradient-primary)',
                    borderRadius: '2px',
                    transition: 'width 0.4s ease',
                }} />
            </div>

            {/* Question card */}
            {currentQuestion && (
                <QuestionCard
                    key={currentQuestion.id}
                    question={currentQuestion}
                    onAnswer={handleAnswer}
                    showResult={showResult}
                    questionNumber={currentIndex + 1}
                    totalQuestions={questions.length}
                />
            )}

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
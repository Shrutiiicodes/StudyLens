'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import QuestionCard from '@/components/QuestionCard';

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

    // Fetch concept title from localStorage or URL
    useEffect(() => {
        const stored = localStorage.getItem('study-lens-user');
        const title = searchParams.get('title') || '';
        setConceptTitle(title);
    }, [conceptId, searchParams]);

    // Generate questions from the API
    useEffect(() => {
        async function fetchQuestions() {
            setLoading(true);
            setError('');

            const title = searchParams.get('title') || '';

            try {
                const res = await fetch('/api/diagnostic', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'generate',
                        conceptId,
                        conceptTitle: title,
                        mode,
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
                console.error('Question generation error:', err);
                setError(
                    err instanceof Error
                        ? err.message
                        : 'Failed to generate questions. Please try again.'
                );
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

            // Submit results to API for storage and mastery update
            try {
                setEvaluating(true);
                const stored = localStorage.getItem('study-lens-user');
                const userId = stored ? JSON.parse(stored).id : null;

                if (userId) {
                    // Build question results for evaluate
                    const questionResults = questions.map((q, i) => ({
                        question_id: q.id,
                        correct: results[i]?.correct ?? (i === results.length ? (currentQuestion ? false : false) : false),
                        difficulty: q.difficulty,
                        cognitive_level: q.cognitive_level,
                        time_taken: results[i]?.timeTaken ?? 0,
                        confidence: results[i]?.confidence ?? 0.5,
                    }));

                    // Add the last answer
                    const lastResult = results[results.length - 1];
                    if (questionResults[results.length - 1] && lastResult) {
                        questionResults[results.length - 1].correct = lastResult.correct;
                        questionResults[results.length - 1].time_taken = lastResult.timeTaken;
                        questionResults[results.length - 1].confidence = lastResult.confidence;
                    }

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
                        console.log('Results stored! Score:', evalData.initialMastery, 'Passed:', evalData.passed, 'Next:', evalData.nextStage);
                    }
                }
            } catch (err) {
                console.error('Failed to submit results:', err);
            } finally {
                setEvaluating(false);
            }
        }
    };

    // Calculate final results
    const correctCount = results.filter((r) => r.correct).length;
    const totalTime = results.reduce((sum, r) => sum + r.timeTaken, 0);
    const avgConfidence = results.length > 0
        ? results.reduce((sum, r) => sum + r.confidence, 0) / results.length
        : 0;
    const scorePercent = results.length > 0
        ? Math.round((correctCount / results.length) * 100)
        : 0;

    const modeLabels: Record<string, string> = {
        diagnostic: '🔍 Diagnostic Test',
        practice: '📝 Practice Mode',
        mastery: '🏆 Mastery Test',
        spaced: '⏰ Spaced Review',
    };

    // Loading state
    if (loading) {
        return (
            <div className="animate-fade-in" style={{ maxWidth: '700px', margin: '0 auto' }}>
                <div className="glass-card" style={{ padding: '60px 40px', textAlign: 'center' }}>
                    <div style={{
                        width: '60px',
                        height: '60px',
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
                        AI is creating personalized questions from your knowledge graph.
                        <br />This may take 15-30 seconds.
                    </p>
                </div>
            </div>
        );
    }

    // Error state
    if (error) {
        return (
            <div className="animate-fade-in" style={{ maxWidth: '700px', margin: '0 auto' }}>
                <div className="glass-card" style={{ padding: '40px', textAlign: 'center' }}>
                    <div style={{ fontSize: '3rem', marginBottom: '16px' }}>⚠️</div>
                    <h2 style={{ fontSize: '1.4rem', fontWeight: 600, marginBottom: '12px' }}>
                        Question Generation Failed
                    </h2>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '24px', fontSize: '0.95rem' }}>
                        {error}
                    </p>
                    <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                        <button
                            className="btn-primary"
                            onClick={() => window.location.reload()}
                        >
                            🔄 Try Again
                        </button>
                        <button
                            className="btn-secondary"
                            onClick={() => router.back()}
                        >
                            ← Go Back
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (testComplete) {
        return (
            <div className="animate-fade-in" style={{ maxWidth: '700px', margin: '0 auto' }}>
                <div className="glass-card" style={{ padding: '40px', textAlign: 'center' }}>
                    <div style={{ fontSize: '4rem', marginBottom: '16px' }}>
                        {scorePercent >= 85 ? '🏆' : scorePercent >= 60 ? '🎯' : '📚'}
                    </div>

                    <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '8px' }}>
                        {scorePercent >= 85 ? 'Excellent!' : scorePercent >= 60 ? 'Good job!' : 'Keep practicing!'}
                    </h1>

                    <p style={{ color: 'var(--text-secondary)', fontSize: '1.05rem', marginBottom: '32px' }}>
                        {evaluating
                            ? 'Saving your results...'
                            : passed
                                ? `You passed! ${nextStage === 'summary' ? 'Write a summary to complete this concept.' : nextStage ? `Stage unlocked: ${nextStage}` : 'Great work!'}`
                                : `You need 60% to pass. Try again to advance to the next stage.`}
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
              ${scorePercent >= 85 ? 'var(--accent-success)' : scorePercent >= 60 ? 'var(--accent-primary)' : 'var(--accent-warning)'}
              ${scorePercent * 3.6}deg,
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
                            <span style={{ fontSize: '2rem', fontWeight: 800 }}>{scorePercent}</span>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>SCORE</span>
                        </div>
                    </div>

                    {/* Stats */}
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, 1fr)',
                        gap: '16px',
                        marginBottom: '32px',
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
                        <button className="btn-secondary" onClick={() => router.push(`/dashboard/learn/${conceptId}`)}>
                            📖 Learn It
                        </button>
                        {!evaluating && passed && nextStage && nextStage !== 'summary' && (
                            <button className="btn-primary" onClick={() => router.push(`/dashboard/test/${conceptId}?mode=${nextStage}&title=${encodeURIComponent(conceptTitle)}`)}>
                                ➡️ Next: {nextStage.charAt(0).toUpperCase() + nextStage.slice(1)}
                            </button>
                        )}
                        {!evaluating && passed && nextStage === 'summary' && (
                            <button className="btn-primary" onClick={() => router.push(`/dashboard/summary/${conceptId}?title=${encodeURIComponent(conceptTitle)}`)}>
                                ✍️ Write Summary
                            </button>
                        )}
                        {!evaluating && !passed && (
                            <button className="btn-primary" onClick={() => {
                                setTestComplete(false);
                                setResults([]);
                                setCurrentIndex(0);
                                setShowResult(false);
                                setQuestions([]);
                                setLoading(true);
                                // Re-fetch questions
                                fetch('/api/diagnostic', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ action: 'generate', conceptId, conceptTitle, mode }),
                                }).then(r => r.json()).then(data => {
                                    if (data.success && data.questions?.length > 0) {
                                        setQuestions(data.questions);
                                    }
                                    setLoading(false);
                                }).catch(() => setLoading(false));
                            }}>
                                🔄 Retry
                            </button>
                        )}
                        <button className="btn-secondary" onClick={() => router.push('/dashboard/concepts')}>
                            ← Back to Concepts
                        </button>
                        <button className="btn-secondary" onClick={() => router.push('/dashboard')}>
                            📊 Dashboard
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (!currentQuestion) {
        return null;
    }

    return (
        <div className="animate-fade-in" style={{ maxWidth: '720px', margin: '0 auto' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                <div>
                    <span className="badge badge-info">{modeLabels[mode]}</span>
                    {conceptTitle && (
                        <span style={{ marginLeft: '12px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                            {conceptTitle}
                        </span>
                    )}
                </div>
                <button className="btn-ghost" onClick={() => router.back()}>
                    ✕ Exit
                </button>
            </div>

            {/* Question */}
            <QuestionCard
                question={currentQuestion}
                onAnswer={handleAnswer}
                showResult={showResult}
                questionNumber={currentIndex + 1}
                totalQuestions={questions.length}
            />

            {/* Next Button */}
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

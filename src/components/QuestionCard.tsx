'use client';

import { useState, useEffect } from 'react';
import { CheckCircle, XCircle } from 'lucide-react';

interface QuestionCardProps {
    question: {
        id: string;
        text: string;
        options: string[];
        correct_answer: string;
        explanation: string;
        type: string;
        difficulty: number;
    };
    onAnswer: (answer: string, timeTaken: number, confidence: number) => void;
    showResult?: boolean;
    questionNumber?: number;
    totalQuestions?: number;
}

export default function QuestionCard({
    question,
    onAnswer,
    showResult = false,
    questionNumber = 1,
    totalQuestions = 5,
}: QuestionCardProps) {
    const [selected, setSelected] = useState<string | null>(null);
    const [confidence, setConfidence] = useState(0.5);
    const [submitted, setSubmitted] = useState(false);
    const [startTime] = useState(Date.now());

    // Reset state when question changes
    useEffect(() => {
        setSelected(null);
        setConfidence(0.5);
        setSubmitted(false);
    }, [question.id]);

    const handleSubmit = () => {
        if (!selected) return;
        const timeTaken = Math.round((Date.now() - startTime) / 1000);
        setSubmitted(true);
        onAnswer(selected, timeTaken, confidence);
    };

    const isCorrect = selected === question.correct_answer;
    const difficultyLabels: Record<number, string> = { 1: 'Easy', 2: 'Medium', 3: 'Hard' };
    const typeColors: Record<string, string> = {
        recall: '#06b6d4',
        conceptual: '#6c5ce7',
        application: '#22c55e',
        reasoning: '#f59e0b',
        analytical: '#ef4444',
    };

    return (
        <div className="glass-card animate-fade-in" style={{ padding: '32px', maxWidth: '720px', margin: '0 auto' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <span className="badge" style={{
                        background: `${typeColors[question.type] || '#6c5ce7'}20`,
                        color: typeColors[question.type] || '#6c5ce7',
                        border: `1px solid ${typeColors[question.type] || '#6c5ce7'}40`,
                        textTransform: 'capitalize',
                    }}>
                        {question.type}
                    </span>
                    <span className="badge" style={{
                        background: 'rgba(255,255,255,0.05)',
                        color: 'var(--text-muted)',
                        border: '1px solid var(--border-subtle)',
                    }}>
                        {difficultyLabels[question.difficulty] || 'Medium'}
                    </span>
                </div>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem', fontWeight: 500 }}>
                    {questionNumber} / {totalQuestions}
                </span>
            </div>

            {/* Progress dots */}
            <div style={{ display: 'flex', gap: '6px', marginBottom: '24px' }}>
                {Array.from({ length: totalQuestions }, (_, i) => (
                    <div
                        key={i}
                        style={{
                            flex: 1,
                            height: '4px',
                            borderRadius: '2px',
                            background: i < questionNumber
                                ? 'var(--gradient-primary)'
                                : 'var(--bg-elevated)',
                            transition: 'all 0.3s',
                        }}
                    />
                ))}
            </div>

            {/* Question */}
            <h2 style={{
                fontSize: '1.15rem',
                fontWeight: 600,
                lineHeight: 1.6,
                marginBottom: '28px',
            }}>
                {question.text}
            </h2>

            {/* Options */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '28px' }}>
                {question.options.map((option, idx) => {
                    let className = 'option-btn';
                    if (submitted && showResult) {
                        if (option === question.correct_answer) className += ' correct';
                        else if (option === selected && !isCorrect) className += ' incorrect';
                    } else if (option === selected) {
                        className += ' selected';
                    }

                    return (
                        <button
                            key={idx}
                            className={className}
                            onClick={() => !submitted && setSelected(option)}
                            disabled={submitted}
                            style={{ opacity: submitted && option !== selected && option !== question.correct_answer ? 0.5 : 1 }}
                        >
                            <span style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                width: '28px',
                                height: '28px',
                                borderRadius: '8px',
                                background: 'rgba(255,255,255,0.05)',
                                marginRight: '12px',
                                fontSize: '0.85rem',
                                fontWeight: 600,
                                flexShrink: 0,
                            }}>
                                {String.fromCharCode(65 + idx)}
                            </span>
                            {option}
                        </button>
                    );
                })}
            </div>

            {/* Confidence Slider */}
            {!submitted && (
                <div style={{ marginBottom: '24px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <label style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                            How confident are you?
                        </label>
                        <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--accent-primary)' }}>
                            {Math.round(confidence * 100)}%
                        </span>
                    </div>
                    <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={confidence}
                        onChange={(e) => setConfidence(Number(e.target.value))}
                        className="confidence-slider"
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Guessing</span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Very Sure</span>
                    </div>
                </div>
            )}

            {/* Submit / Result */}
            {!submitted ? (
                <button
                    className="btn-primary"
                    onClick={handleSubmit}
                    disabled={!selected}
                    style={{
                        width: '100%',
                        justifyContent: 'center',
                        padding: '14px',
                        opacity: selected ? 1 : 0.5,
                    }}
                >
                    Submit Answer
                </button>
            ) : showResult && (
                <div className="animate-fade-in" style={{
                    padding: '20px',
                    borderRadius: 'var(--radius-md)',
                    background: isCorrect ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
                    border: `1px solid ${isCorrect ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`,
                }}>
                        <div style={{
                            fontWeight: 600,
                            marginBottom: '8px',
                            color: isCorrect ? 'var(--accent-success)' : 'var(--accent-danger)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                        }}>
                            {isCorrect ? <><CheckCircle size={18} /> Correct!</> : <><XCircle size={18} /> Incorrect</>}
                        </div>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: 1.6 }}>
                        {question.explanation}
                    </p>
                </div>
            )}
        </div>
    );
}

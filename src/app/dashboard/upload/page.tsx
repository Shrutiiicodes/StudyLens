'use client';

import { useState, useEffect } from 'react';
import UploadZone from '@/components/UploadZone';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface ConceptRecord {
    id: string;
    title: string;
    created_at: string;
}

interface UploadResult {
    success: boolean;
    concept?: { id: string; title: string };
    knowledgeGraph?: { nodeCount: number; relationCount: number };
    warnings?: string[];
    validation?: { wordCount: number; conceptDensity: number };
    error?: string;
}

export default function UploadPage() {
    const router = useRouter();
    const [uploading, setUploading] = useState(false);
    const [result, setResult] = useState<UploadResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [concepts, setConcepts] = useState<ConceptRecord[]>([]);

    const fetchConcepts = async () => {
        try {
            const stored = localStorage.getItem('study-lens-user');
            if (!stored) return;
            const user = JSON.parse(stored);
            const res = await fetch(`/api/concepts?userId=${user.id}`);
            const data = await res.json();
            if (data.success) {
                setConcepts(data.concepts);
            }
        } catch (err) {
            console.error('Failed to fetch concepts:', err);
        }
    };

    useEffect(() => {
        fetchConcepts();
    }, []);

    const handleUpload = async (file: File) => {
        setUploading(true);
        setError(null);
        setResult(null);

        try {
            const stored = localStorage.getItem('study-lens-user');
            const user = stored ? JSON.parse(stored) : null;

            if (!user) {
                setError('Please sign in to upload documents.');
                setUploading(false);
                return;
            }

            const formData = new FormData();
            formData.append('file', file);
            formData.append('userId', user.id);

            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData,
            });

            const data = await response.json();

            if (!response.ok) {
                setError(data.error || 'Upload failed');
                setUploading(false);
                return;
            }

            setResult(data);
            fetchConcepts(); // Refresh list
        } catch {
            setError('Network error. Please try again.');
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="animate-fade-in" style={{ maxWidth: '800px' }}>
            <div style={{ marginBottom: '32px' }}>
                <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '8px' }}>
                    Upload Study Material
                </h1>
                <p style={{ color: 'var(--text-secondary)', fontSize: '1rem' }}>
                    Upload a PDF or DOCX file to build a knowledge graph and start learning
                </p>
            </div>

            {/* Upload Zone */}
            <UploadZone onUpload={handleUpload} uploading={uploading} />

            {/* Error */}
            {error && (
                <div className="animate-fade-in" style={{
                    marginTop: '20px',
                    padding: '16px 20px',
                    borderRadius: 'var(--radius-md)',
                    background: 'rgba(239, 68, 68, 0.08)',
                    border: '1px solid rgba(239, 68, 68, 0.2)',
                    color: 'var(--accent-danger)',
                }}>
                    ❌ {error}
                </div>
            )}

            {/* Success Result */}
            {result?.success && (
                <div className="animate-fade-in glass-card" style={{ marginTop: '24px', padding: '28px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
                        <div style={{
                            width: '48px',
                            height: '48px',
                            borderRadius: '12px',
                            background: 'rgba(34, 197, 94, 0.15)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '24px',
                        }}>
                            ✅
                        </div>
                        <div>
                            <h3 style={{ fontWeight: 600, fontSize: '1.1rem' }}>Document Analyzed Successfully!</h3>
                            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                                {result.concept?.title}
                            </p>
                        </div>
                    </div>

                    {/* Stats */}
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, 1fr)',
                        gap: '12px',
                        marginBottom: '20px',
                    }}>
                        <div className="stat-card" style={{ padding: '16px', textAlign: 'center' }}>
                            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--accent-primary)' }}>
                                {result.knowledgeGraph?.nodeCount || 0}
                            </div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Nodes</div>
                        </div>
                        <div className="stat-card" style={{ padding: '16px', textAlign: 'center' }}>
                            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--accent-tertiary)' }}>
                                {result.knowledgeGraph?.relationCount || 0}
                            </div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Relations</div>
                        </div>
                        <div className="stat-card" style={{ padding: '16px', textAlign: 'center' }}>
                            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--accent-success)' }}>
                                {result.validation?.wordCount || 0}
                            </div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Words</div>
                        </div>
                    </div>

                    {/* Warnings */}
                    {result.warnings && result.warnings.length > 0 && (
                        <div style={{ marginBottom: '20px' }}>
                            {result.warnings.map((w, i) => (
                                <div key={i} style={{
                                    padding: '10px 14px',
                                    borderRadius: 'var(--radius-sm)',
                                    background: 'rgba(245, 158, 11, 0.08)',
                                    border: '1px solid rgba(245, 158, 11, 0.2)',
                                    color: 'var(--accent-warning)',
                                    fontSize: '0.85rem',
                                    marginBottom: '8px',
                                }}>
                                    ⚠️ {w}
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Action Buttons */}
                    <div style={{ display: 'flex', gap: '12px' }}>
                        <Link
                            className="btn-primary"
                            href={`/dashboard/test/${result.concept?.id}?mode=diagnostic&title=${encodeURIComponent(result.concept?.title || '')}`}
                            style={{ textDecoration: 'none' }}
                        >
                            🎯 Take Diagnostic Test
                        </Link>
                        <button className="btn-secondary" onClick={() => { setResult(null); }}>
                            📄 Upload Another
                        </button>
                    </div>
                </div>
            )}

            {/* Your Uploads */}
            {!result?.success && concepts.length > 0 && (
                <div style={{ marginTop: '40px' }}>
                    <hr style={{ border: 'none', borderTop: '1px solid var(--border-subtle)', marginBottom: '32px' }} />
                    <h2 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '16px' }}>
                        Your Uploaded Documents
                    </h2>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {concepts.map((c) => (
                            <div key={c.id} className="glass-card" style={{ padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div>
                                    <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>📄 {c.title}</div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                        Uploaded {new Date(c.created_at).toLocaleDateString()}
                                    </div>
                                </div>
                                <Link
                                    href={`/dashboard/concepts`}
                                    className="btn-ghost"
                                    style={{ fontSize: '0.85rem', textDecoration: 'none' }}
                                >
                                    View Progress →
                                </Link>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

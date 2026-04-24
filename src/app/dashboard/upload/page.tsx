'use client';

import { useState, useEffect } from 'react';
import UploadZone from '@/components/UploadZone';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { XCircle, CheckCircle, AlertTriangle, Target, FileText, Trash2 } from 'lucide-react';
import { ConceptRecord } from '@/types/concept';

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
    const [deletingId, setDeletingId] = useState<string | null>(null);
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
    async function handleDelete(concept: ConceptRecord) {
        const confirmed = window.confirm(
            `Delete "${concept.title}"?\n\nThis will permanently remove the concept, all test history, and mastery progress. This cannot be undone.`
        );
        if (!confirmed) return;

        const stored = localStorage.getItem('study-lens-user');
        if (!stored) return;
        const user = JSON.parse(stored);

        setDeletingId(concept.id);
        try {
            const res = await fetch(`/api/concepts/${concept.id}?userId=${user.id}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                setConcepts(prev => prev.filter(c => c.id !== concept.id));
            } else {
                alert(`Failed to delete: ${data.error}`);
            }
        } catch {
            alert('Network error. Please try again.');
        } finally {
            setDeletingId(null);
        }
    }
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
        <div className="animate-fade-in" style={{ maxWidth: '1100px', margin: '0 auto' }}>
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
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                }}>
                    <XCircle size={20} /> {error}
                </div>
            )}

            {/* Your Uploads */}
            {concepts.length > 0 && (
                <div style={{ marginTop: '40px' }}>
                    <hr style={{ border: 'none', borderTop: '1px solid var(--border-subtle)', marginBottom: '32px' }} />
                    <h2 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '16px' }}>
                        Your Uploaded Documents
                    </h2>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {concepts.map((c) => (
                            <div key={c.id} className="glass-card" style={{ padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div>
                                    <div style={{ fontWeight: 600, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '8px', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                                        <FileText size={16} style={{ flexShrink: 0 }} /> <span>{c.title}</span>
                                    </div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '24px' }}>
                                        Uploaded {new Date(c.created_at).toLocaleDateString()}
                                    </div>
                                </div>
                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
                                    <Link
                                        href={`/dashboard/concepts`}
                                        className="btn-ghost"
                                        style={{ fontSize: '0.85rem', textDecoration: 'none' }}
                                    >
                                        View Progress →
                                    </Link>
                                    <button
                                        onClick={() => handleDelete(c)}
                                        disabled={deletingId === c.id}
                                        title="Delete document"
                                        style={{
                                            background: 'transparent',
                                            border: '1px solid rgba(239,68,68,0.3)',
                                            borderRadius: 'var(--radius-md)',
                                            padding: '8px 10px',
                                            cursor: deletingId === c.id ? 'not-allowed' : 'pointer',
                                            color: deletingId === c.id ? 'var(--text-muted)' : '#ef4444',
                                            display: 'flex',
                                            alignItems: 'center',
                                            opacity: deletingId === c.id ? 0.5 : 1,
                                            transition: 'all 0.2s',
                                        }}
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

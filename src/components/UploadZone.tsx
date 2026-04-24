'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { FileText, Rocket, UploadCloud } from 'lucide-react';

interface UploadZoneProps {
    onUpload: (file: File) => void;
    uploading: boolean;
}

export default function UploadZone({ onUpload, uploading }: UploadZoneProps) {
    const [isDragOver, setIsDragOver] = useState(false);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [elapsedSec, setElapsedSec] = useState(0);

    useEffect(() => {
        if (!uploading) {
            setElapsedSec(0);
            return;
        }
        const started = Date.now();
        const id = setInterval(() => {
            setElapsedSec(Math.floor((Date.now() - started) / 1000));
        }, 1000);
        return () => clearInterval(id);
    }, [uploading]);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(true);
    }, []);

    const handleDragLeave = useCallback(() => {
        setIsDragOver(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);

        const file = e.dataTransfer.files[0];
        if (file) {
            validateAndSet(file);
        }
    }, []);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            validateAndSet(file);
        }
    };

    const validateAndSet = (file: File) => {
        const allowedTypes = [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ];

        if (!allowedTypes.includes(file.type)) {
            alert('Only PDF and DOCX files are supported.');
            return;
        }

        if (file.size > 10 * 1024 * 1024) {
            alert('File size must be under 10MB.');
            return;
        }

        setSelectedFile(file);
    };

    const handleUpload = () => {
        if (selectedFile) {
            onUpload(selectedFile);
        }
    };



    return (
        <div>
            <div
                className={`upload-zone ${isDragOver ? 'dragover' : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                style={{ opacity: uploading ? 0.6 : 1, pointerEvents: uploading ? 'none' : 'auto' }}
            >
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.docx"
                    onChange={handleFileSelect}
                    style={{ display: 'none' }}
                />

                <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'center' }}>
                    <UploadCloud size={48} color="var(--accent-primary)" strokeWidth={1.5} />
                </div>

                {selectedFile ? (
                    <div>
                        <p style={{ fontWeight: 600, fontSize: '1.05rem', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
                            <FileText size={18} /> {selectedFile.name}
                        </p>
                        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                            {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                        </p>
                    </div>
                ) : (
                    <div>
                        <p style={{ fontWeight: 600, fontSize: '1.05rem', marginBottom: '8px' }}>
                            {isDragOver ? 'Drop your file here' : 'Drag & drop your study material'}
                        </p>
                        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                            PDF or DOCX · MAX 10MB
                        </p>
                    </div>
                )}
            </div>

            {selectedFile && !uploading && (
                <div style={{ display: 'flex', gap: '12px', marginTop: '16px', justifyContent: 'center' }}>
                    <button className="btn-secondary" onClick={() => setSelectedFile(null)}>
                        Cancel
                    </button>
                    <button className="btn-primary" onClick={handleUpload} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <Rocket size={18} /> Upload & Analyze
                    </button>
                </div>
            )}

            {uploading && (() => {
                const stage = elapsedSec < 10
                    ? 'Extracting text from document...'
                    : elapsedSec < 30
                        ? 'Analyzing concepts & relationships...'
                        : elapsedSec < 60
                            ? 'Building knowledge graph...'
                            : elapsedSec < 90
                                ? 'Generating questions & finalizing...'
                                : 'Almost there — large documents can take a bit longer...';

                const mins = Math.floor(elapsedSec / 60);
                const secs = elapsedSec % 60;
                const timeLabel = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

                return (
                    <div style={{ textAlign: 'center', marginTop: '20px' }}>
                        <div className="progress-bar" style={{ maxWidth: '400px', margin: '0 auto 12px' }}>
                            <div className="progress-bar-fill" style={{
                                width: '100%',
                                background: 'var(--gradient-primary)',
                            }} />
                        </div>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '4px' }}>
                            {stage}
                        </p>
                        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                            {timeLabel} elapsed
                        </p>
                    </div>
                );
            })()}
        </div>
    );
}

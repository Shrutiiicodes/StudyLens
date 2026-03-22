'use client';

import { useState, useRef, useCallback } from 'react';

interface UploadZoneProps {
    onUpload: (file: File) => void;
    uploading: boolean;
}

export default function UploadZone({ onUpload, uploading }: UploadZoneProps) {
    const [isDragOver, setIsDragOver] = useState(false);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

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

                <div style={{ marginBottom: '16px' }}>
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ margin: '0 auto' }}>
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                        <polyline points="17,8 12,3 7,8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                </div>

                {selectedFile ? (
                    <div>
                        <p style={{ fontWeight: 600, fontSize: '1.05rem', marginBottom: '4px' }}>
                            📄 {selectedFile.name}
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
                    <button className="btn-primary" onClick={handleUpload}>
                        🚀 Upload & Analyze
                    </button>
                </div>
            )}

            {uploading && (
                <div style={{ textAlign: 'center', marginTop: '20px' }}>
                    <div className="progress-bar" style={{ maxWidth: '400px', margin: '0 auto 12px' }}>
                        <div className="progress-bar-fill" style={{
                            width: '70%',
                            background: 'var(--gradient-primary)',
                        }} />
                    </div>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                        Analyzing document & building knowledge graph...
                    </p>
                </div>
            )}
        </div>
    );
}

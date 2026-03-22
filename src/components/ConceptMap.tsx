'use client';

import { useEffect, useRef } from 'react';

interface ConceptMapNode {
    id: string;
    label: string;
    type: 'concept' | 'definition' | 'example' | 'formula' | 'misconception';
    x?: number;
    y?: number;
}

interface ConceptMapEdge {
    source: string;
    target: string;
    type: string;
}

interface ConceptMapProps {
    nodes: ConceptMapNode[];
    edges: ConceptMapEdge[];
    width?: number;
    height?: number;
}

const typeColors: Record<string, string> = {
    concept: '#6c5ce7',
    definition: '#06b6d4',
    example: '#22c55e',
    formula: '#f59e0b',
    misconception: '#ef4444',
};

export default function ConceptMap({ nodes, edges, width = 800, height = 500 }: ConceptMapProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (!canvasRef.current || nodes.length === 0) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Set canvas size
        const dpr = window.devicePixelRatio || 1;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        ctx.scale(dpr, dpr);

        // Layout nodes in a force-directed-like pattern
        const layoutNodes = nodes.map((node, i) => {
            const angle = (2 * Math.PI * i) / nodes.length;
            const radius = Math.min(width, height) * 0.3;
            const cx = width / 2;
            const cy = height / 2;

            // Concepts go in inner ring, others in outer ring
            const r = node.type === 'concept' ? radius * 0.6 : radius;

            return {
                ...node,
                x: cx + r * Math.cos(angle) + (Math.random() - 0.5) * 40,
                y: cy + r * Math.sin(angle) + (Math.random() - 0.5) * 40,
            };
        });

        // Clear
        ctx.fillStyle = 'transparent';
        ctx.clearRect(0, 0, width, height);

        // Draw edges
        edges.forEach((edge) => {
            const source = layoutNodes.find((n) => n.id === edge.source);
            const target = layoutNodes.find((n) => n.id === edge.target);
            if (!source || !target) return;

            ctx.beginPath();
            ctx.moveTo(source.x!, source.y!);
            ctx.lineTo(target.x!, target.y!);
            ctx.strokeStyle = 'rgba(108, 92, 231, 0.2)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        });

        // Draw nodes
        layoutNodes.forEach((node) => {
            const color = typeColors[node.type] || '#6c5ce7';
            const radius = node.type === 'concept' ? 24 : 16;

            // Glow
            ctx.beginPath();
            ctx.arc(node.x!, node.y!, radius + 4, 0, Math.PI * 2);
            ctx.fillStyle = `${color}20`;
            ctx.fill();

            // Node
            ctx.beginPath();
            ctx.arc(node.x!, node.y!, radius, 0, Math.PI * 2);
            ctx.fillStyle = `${color}40`;
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.fill();
            ctx.stroke();

            // Label
            ctx.fillStyle = '#e8e8ff';
            ctx.font = `${node.type === 'concept' ? '12' : '10'}px Inter, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            const label = node.label.length > 15 ? node.label.substring(0, 15) + '...' : node.label;
            ctx.fillText(label, node.x!, node.y! + radius + 16);
        });
    }, [nodes, edges, width, height]);

    if (nodes.length === 0) {
        return (
            <div className="glass-card" style={{
                padding: '48px',
                textAlign: 'center',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '12px',
            }}>
                <div style={{ fontSize: '3rem' }}>🕸️</div>
                <p style={{ color: 'var(--text-secondary)' }}>
                    Upload a document to see your concept map
                </p>
            </div>
        );
    }

    return (
        <div className="glass-card" style={{ padding: '20px', overflow: 'hidden' }}>
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '16px',
            }}>
                <h3 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                    Knowledge Graph
                </h3>
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    {Object.entries(typeColors).map(([type, color]) => (
                        <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <div style={{
                                width: '10px',
                                height: '10px',
                                borderRadius: '50%',
                                background: color,
                            }} />
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>
                                {type}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
            <canvas
                ref={canvasRef}
                style={{
                    width: '100%',
                    height: `${height}px`,
                    borderRadius: 'var(--radius-md)',
                }}
            />
        </div>
    );
}

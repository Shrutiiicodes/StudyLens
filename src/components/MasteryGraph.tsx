'use client';

import {
    ResponsiveContainer,
    RadarChart,
    PolarGrid,
    PolarAngleAxis,
    PolarRadiusAxis,
    Radar,
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
} from 'recharts';

interface MasteryGraphProps {
    type: 'radar' | 'timeline';
    data: Record<string, number> | Array<{ date: string; score: number }>;
    title?: string;
}

export default function MasteryGraph({ type, data, title }: MasteryGraphProps) {
    if (type === 'radar') {
        const radarData = Object.entries(data as Record<string, number>).map(([key, value]) => ({
            subject: key.charAt(0).toUpperCase() + key.slice(1),
            score: value,
            fullMark: 100,
        }));

        return (
            <div className="glass-card" style={{ padding: '24px' }}>
                {title && (
                    <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '16px', color: 'var(--text-secondary)' }}>
                        {title}
                    </h3>
                )}
                <ResponsiveContainer width="100%" height={280}>
                    <RadarChart data={radarData}>
                        <PolarGrid stroke="rgba(108, 92, 231, 0.15)" />
                        <PolarAngleAxis
                            dataKey="subject"
                            tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
                        />
                        <PolarRadiusAxis
                            angle={90}
                            domain={[0, 100]}
                            tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                        />
                        <Radar
                            name="Score"
                            dataKey="score"
                            stroke="#6c5ce7"
                            fill="#6c5ce7"
                            fillOpacity={0.2}
                            strokeWidth={2}
                        />
                    </RadarChart>
                </ResponsiveContainer>
            </div>
        );
    }

    // Timeline chart
    const timelineData = (data as Array<{ date: string; score: number }>).map((d) => ({
        ...d,
        date: new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    }));

    return (
        <div className="glass-card" style={{ padding: '24px' }}>
            {title && (
                <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '16px', color: 'var(--text-secondary)' }}>
                    {title}
                </h3>
            )}
            <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={timelineData}>
                    <defs>
                        <linearGradient id="masteryGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#6c5ce7" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#6c5ce7" stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(108, 92, 231, 0.1)" />
                    <XAxis
                        dataKey="date"
                        tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                        axisLine={{ stroke: 'var(--border-subtle)' }}
                    />
                    <YAxis
                        domain={[0, 100]}
                        tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                        axisLine={{ stroke: 'var(--border-subtle)' }}
                    />
                    <Tooltip
                        contentStyle={{
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border-subtle)',
                            borderRadius: '8px',
                            color: 'var(--text-primary)',
                        }}
                    />
                    <Area
                        type="monotone"
                        dataKey="score"
                        stroke="#6c5ce7"
                        strokeWidth={2}
                        fill="url(#masteryGradient)"
                    />
                </AreaChart>
            </ResponsiveContainer>
        </div>
    );
}

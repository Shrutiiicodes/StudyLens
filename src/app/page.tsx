
'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  FileText, Brain, Target, BarChart, Clock, Trophy, Microscope, Rocket, Sparkles, Infinity
} from 'lucide-react';

export default function HomePage() {
  const [isHovered, setIsHovered] = useState<number | null>(null);

  const features = [
    {
      icon: <FileText size={32} />,
      title: 'Smart Document Upload',
      description: 'Upload PDF or DOCX files and our AI extracts concepts, relationships, and builds a knowledge graph automatically.',
      gradient: 'linear-gradient(135deg, #6c5ce7, #a855f7)',
    },
    {
      icon: <Brain size={32} />,
      title: 'Knowledge Graph',
      description: 'Visualize how concepts connect. See prerequisites, definitions, examples, and common misconceptions at a glance.',
      gradient: 'linear-gradient(135deg, #06b6d4, #6c5ce7)',
    },
    {
      icon: <Target size={32} />,
      title: 'Adaptive Assessment',
      description: '5 question types × 3 difficulty levels. Questions adapt to your mastery level in real-time.',
      gradient: 'linear-gradient(135deg, #22c55e, #06b6d4)',
    },
    {
      icon: <BarChart size={32} />,
      title: 'Mastery Tracking',
      description: 'Mathematical precision: accuracy, cognitive depth, speed, confidence calibration — all tracked and visualized.',
      gradient: 'linear-gradient(135deg, #f59e0b, #ef4444)',
    },
    {
      icon: <Clock size={32} />,
      title: 'Spaced Reinforcement',
      description: 'Forgetting model ensures you review concepts at the optimal time. Never let your mastery decay.',
      gradient: 'linear-gradient(135deg, #a855f7, #ec4899)',
    },
    {
      icon: <Trophy size={32} />,
      title: 'Student Ability Index',
      description: 'A holistic score combining mastery, trends, accuracy, and calibration. Track your growth over time.',
      gradient: 'linear-gradient(135deg, #f59e0b, #22c55e)',
    },
  ];

  return (
    <div className="bg-grid" style={{ minHeight: '100vh' }}>
      {/* ── Hero Section ── */}
      <nav style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '20px 40px',
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        background: 'rgba(10, 10, 26, 0.8)',
        backdropFilter: 'blur(20px)',
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '40px',
            height: '40px',
            borderRadius: '12px',
            background: 'var(--gradient-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '20px',
          }}>
            <Microscope size={24} color="white" />
          </div>
          <span style={{
            fontSize: '1.3rem',
            fontWeight: 700,
            letterSpacing: '-0.02em',
          }}>
            <span className="gradient-text">Study</span> Lens
          </span>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <Link href="/login" className="btn-secondary" style={{ textDecoration: 'none' }}>
            Sign In
          </Link>
          <Link href="/login" className="btn-primary" style={{ textDecoration: 'none' }}>
            Get Started
          </Link>
        </div>
      </nav>

      {/* ── Hero Content ── */}
      <section style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        minHeight: '100vh',
        padding: '120px 20px 80px',
        position: 'relative',
      }}>
        {/* Background Glow */}
        <div style={{
          position: 'absolute',
          width: '600px',
          height: '600px',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(108, 92, 231, 0.15) 0%, transparent 70%)',
          top: '10%',
          left: '50%',
          transform: 'translateX(-50%)',
          pointerEvents: 'none',
        }} />

        <div className="animate-fade-in" style={{ position: 'relative', zIndex: 1 }}>
          <div className="badge badge-info" style={{ marginBottom: '24px' }}>
            <Sparkles size={16} /> AI-Powered Learning Platform
          </div>

          <h1 style={{
            fontSize: 'clamp(2.5rem, 6vw, 4.5rem)',
            fontWeight: 800,
            lineHeight: 1.1,
            maxWidth: '900px',
            marginBottom: '24px',
            letterSpacing: '-0.03em',
          }}>
            Master Concepts with{' '}
            <span className="gradient-text">Intelligent</span>
            <br />Adaptive Learning
          </h1>

          <p style={{
            fontSize: '1.2rem',
            color: 'var(--text-secondary)',
            maxWidth: '600px',
            marginBottom: '40px',
            lineHeight: 1.7,
          }}>
            Upload your study materials and let AI build a knowledge graph, generate adaptive questions, and track your mastery with mathematical precision.
          </p>

          <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link href="/login" className="btn-primary" style={{
              padding: '16px 36px',
              fontSize: '1.1rem',
              textDecoration: 'none',
            }}>
              <Rocket size={20} /> Start Learning
            </Link>
            <a href="#features" className="btn-secondary" style={{
              padding: '16px 36px',
              fontSize: '1.1rem',
              textDecoration: 'none',
            }}>
              Explore Features
            </a>
          </div>
        </div>

        {/* Stats Bar */}
        <div style={{
          display: 'flex',
          gap: '48px',
          marginTop: '80px',
          padding: '24px 48px',
          borderRadius: 'var(--radius-xl)',
          background: 'var(--bg-card)',
          backdropFilter: 'blur(20px)',
          border: '1px solid var(--border-subtle)',
        }} className="animate-fade-in">
          {[
            { value: '5', label: 'Question Types' },
            { value: '3', label: 'Difficulty Levels' },
            { value: '4', label: 'Assessment Modes' },
            { value: <Infinity size={24} />, label: 'Adaptive Paths' },
          ].map((stat, idx) => (
            <div key={idx} style={{ textAlign: 'center' }}>
              <div className="gradient-text" style={{ fontSize: '2rem', fontWeight: 800 }}>
                {stat.value}
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Features Section ── */}
      <section id="features" style={{
        padding: '100px 20px',
        maxWidth: '1200px',
        margin: '0 auto',
      }}>
        <div style={{ textAlign: 'center', marginBottom: '60px' }}>
          <h2 style={{ fontSize: '2.5rem', fontWeight: 700, marginBottom: '16px' }}>
            Everything You Need to{' '}
            <span className="gradient-text">Excel</span>
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '1.1rem', maxWidth: '500px', margin: '0 auto' }}>
            A comprehensive platform designed for deep conceptual understanding, not just rote memorization.
          </p>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
          gap: '24px',
        }}>
          {features.map((feature, idx) => (
            <div
              key={idx}
              className="glass-card animate-fade-in"
              style={{
                padding: '32px',
                animationDelay: `${idx * 100}ms`,
                cursor: 'default',
                position: 'relative',
                overflow: 'hidden',
              }}
              onMouseEnter={() => setIsHovered(idx)}
              onMouseLeave={() => setIsHovered(null)}
            >
              {/* Gradient accent line */}
              <div style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: '3px',
                background: feature.gradient,
                opacity: isHovered === idx ? 1 : 0,
                transition: 'opacity 0.3s',
              }} />

              <div style={{
                fontSize: '2.5rem',
                marginBottom: '16px',
              }}>
                {feature.icon}
              </div>
              <h3 style={{
                fontSize: '1.2rem',
                fontWeight: 600,
                marginBottom: '12px',
              }}>
                {feature.title}
              </h3>
              <p style={{
                color: 'var(--text-secondary)',
                fontSize: '0.95rem',
                lineHeight: 1.6,
              }}>
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How It Works ── */}
      <section style={{
        padding: '100px 20px',
        maxWidth: '900px',
        margin: '0 auto',
      }}>
        <div style={{ textAlign: 'center', marginBottom: '60px' }}>
          <h2 style={{ fontSize: '2.5rem', fontWeight: 700, marginBottom: '16px' }}>
            How It <span className="gradient-text-secondary">Works</span>
          </h2>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
          {[
            { step: '01', title: 'Upload Your Material', description: 'Upload a PDF or DOCX file with your study material. Our AI validates it for academic quality.' },
            { step: '02', title: 'AI Builds Knowledge Graph', description: 'Concepts, definitions, examples, formulas, and misconceptions are extracted and connected.' },
            { step: '03', title: 'Take Diagnostic Test', description: '5 carefully crafted questions assess your current understanding across cognitive levels.' },
            { step: '04', title: 'Personalized Learning Path', description: 'Based on your diagnostic, choose "Test It" to prove mastery or "Learn It" to study deeper.' },
            { step: '05', title: 'Track & Grow', description: 'Watch your mastery grow with spaced reinforcement and adaptive difficulty.' },
          ].map((item, idx) => (
            <div key={idx} className="glass-card animate-fade-in" style={{
              display: 'flex',
              gap: '24px',
              padding: '28px 32px',
              alignItems: 'center',
              animationDelay: `${idx * 100}ms`,
            }}>
              <div style={{
                fontSize: '1.5rem',
                fontWeight: 800,
                minWidth: '48px',
                height: '48px',
                borderRadius: '12px',
                background: 'var(--gradient-primary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                {item.step}
              </div>
              <div>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '4px' }}>
                  {item.title}
                </h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
                  {item.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA Section ── */}
      <section style={{
        padding: '100px 20px',
        textAlign: 'center',
      }}>
        <div className="glass-card animate-pulse-glow" style={{
          maxWidth: '800px',
          margin: '0 auto',
          padding: '64px 48px',
          position: 'relative',
          overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute',
            width: '300px',
            height: '300px',
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(108, 92, 231, 0.2) 0%, transparent 70%)',
            top: '-100px',
            right: '-100px',
            pointerEvents: 'none',
          }} />

          <h2 style={{ fontSize: '2.2rem', fontWeight: 700, marginBottom: '16px', position: 'relative' }}>
            Ready to <span className="gradient-text">Master</span> Your Concepts?
          </h2>
          <p style={{
            color: 'var(--text-secondary)',
            fontSize: '1.1rem',
            marginBottom: '32px',
            maxWidth: '500px',
            margin: '0 auto 32px',
          }}>
            Join students who are learning smarter, not harder, with AI-powered adaptive learning.
          </p>
          <Link href="/login" className="btn-primary" style={{
            padding: '16px 48px',
            fontSize: '1.1rem',
            textDecoration: 'none',
          }}>
            Get Started — It&apos;s Free
          </Link>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer style={{
        padding: '40px 20px',
        textAlign: 'center',
        borderTop: '1px solid var(--border-subtle)',
        color: 'var(--text-muted)',
        fontSize: '0.9rem',
      }}>
        <p>© 2026 Study Lens. Built for CBSE Grade 4–10 Students.</p>
      </footer>
    </div>
  );
}

export interface Profile {
  id: string;
  full_name: string;
  grade: number;
  created_at: string;
  avatar_url?: string;
}

export interface StudentDashboardData {
  profile: Profile;
  conceptCount: number;
  overallMastery: number;
  sai: number;
  recentAttempts: AttemptSummary[];
  strengthWeakness: StrengthWeakness;
}

export interface AttemptSummary {
  id: string;
  concept_title: string;
  score: number;
  mode: AssessmentMode;
  date: string;
  question_count: number;
  correct_count: number;
}

export interface StrengthWeakness {
  strengths: string[];
  weaknesses: string[];
  recall: number;
  conceptual: number;
  application: number;
  reasoning: number;
  analytical: number;
}

/**
 * The three real assessment modes in Study Lens.
 *
 * 'spaced' is intentionally NOT a mode here.
 * Spaced review questions are injected silently into 'practice' and
 * 'mastery' sessions from older same-document concepts. They are
 * tracked via the `is_spaced_review` boolean on the attempts row,
 * not via a separate mode. This keeps session logic clean and
 * prevents spaced questions from being treated as a different
 * assessment pipeline.
 */
export type AssessmentMode = 'diagnostic' | 'practice' | 'mastery';
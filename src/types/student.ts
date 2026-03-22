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

export type AssessmentMode = 'diagnostic' | 'practice' | 'mastery' | 'spaced';

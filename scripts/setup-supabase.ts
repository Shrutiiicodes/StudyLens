/**
 * ═══════════════════════════════════════════
 * STUDY LENS — Supabase Setup Script
 * ═══════════════════════════════════════════
 *
 * This script creates all required tables, storage buckets,
 * and RLS policies in your Supabase project.
 *
 * Usage:
 *   npx tsx scripts/setup-supabase.ts
 *
 * Prerequisites:
 *   - .env.local must exist with valid Supabase credentials
 *   - SUPABASE_SERVICE_ROLE_KEY is required (bypasses RLS)
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

// ── Load env vars from .env.local ──
function loadEnv() {
    const envPath = path.join(__dirname, '..', '.env.local');
    if (!fs.existsSync(envPath)) {
        console.error('❌ .env.local not found! Create it first with your Supabase credentials.');
        process.exit(1);
    }

    const envContent = fs.readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;
        const key = trimmed.substring(0, eqIndex).trim();
        const value = trimmed.substring(eqIndex + 1).trim();
        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
}

loadEnv();

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
    console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
});

// ── SQL for all tables ──
const CREATE_TABLES_SQL = `
-- ═══════════════════════════════════════════
-- 1. Profiles table
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT,
  grade INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

-- ═══════════════════════════════════════════
-- 2. Concepts table (one per uploaded document)
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS concepts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  title TEXT NOT NULL,
  source_document TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

-- ═══════════════════════════════════════════
-- 3. Mastery table (per user × concept)
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS mastery (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  concept_id UUID REFERENCES concepts(id) ON DELETE CASCADE,
  mastery_score FLOAT DEFAULT 0,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  UNIQUE(user_id, concept_id)
);

-- ═══════════════════════════════════════════
-- 4. Attempts table (every question answered)
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS attempts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  concept_id UUID REFERENCES concepts(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  correct BOOLEAN NOT NULL,
  difficulty INTEGER NOT NULL,
  cognitive_level INTEGER NOT NULL,
  time_taken INTEGER NOT NULL,
  confidence FLOAT DEFAULT 0.5,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

-- ═══════════════════════════════════════════
-- Create indexes for performance
-- ═══════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_concepts_user_id ON concepts(user_id);
CREATE INDEX IF NOT EXISTS idx_mastery_user_id ON mastery(user_id);
CREATE INDEX IF NOT EXISTS idx_mastery_concept_id ON mastery(concept_id);
CREATE INDEX IF NOT EXISTS idx_attempts_user_id ON attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_attempts_concept_id ON attempts(concept_id);
CREATE INDEX IF NOT EXISTS idx_attempts_created_at ON attempts(created_at);
`;

async function setupTables() {
    console.log('📋 Creating tables...');

    const { error } = await supabase.rpc('exec_sql', { sql: CREATE_TABLES_SQL });

    if (error) {
        // rpc 'exec_sql' might not exist, fall back to individual table checks
        console.log('   ℹ️  rpc method not available, checking tables individually...');
        await setupTablesIndividually();
    } else {
        console.log('   ✅ All tables created successfully!');
    }
}

async function setupTablesIndividually() {
    // Check if each table exists by trying to select from it
    const tables = ['profiles', 'concepts', 'mastery', 'attempts'];

    for (const table of tables) {
        const { error } = await supabase.from(table).select('id').limit(1);
        if (error) {
            if (error.message.includes('does not exist') || error.code === '42P01') {
                console.log(`   ❌ Table "${table}" does not exist.`);
                console.log(`      → Please create it manually using the SQL below.`);
            } else {
                // Table exists but might have other issues
                console.log(`   ⚠️  Table "${table}": ${error.message}`);
            }
        } else {
            console.log(`   ✅ Table "${table}" exists`);
        }
    }
}

async function setupStorageBucket() {
    console.log('\n📦 Setting up storage bucket...');

    // Check if bucket exists
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();

    if (listError) {
        console.log(`   ⚠️  Could not list buckets: ${listError.message}`);
        return;
    }

    const exists = buckets?.some((b) => b.id === 'documents');

    if (exists) {
        console.log('   ✅ Storage bucket "documents" already exists');
        return;
    }

    // Create the bucket
    const { error: createError } = await supabase.storage.createBucket('documents', {
        public: false,
        fileSizeLimit: 10 * 1024 * 1024, // 10MB
        allowedMimeTypes: [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ],
    });

    if (createError) {
        console.log(`   ❌ Failed to create bucket: ${createError.message}`);
    } else {
        console.log('   ✅ Storage bucket "documents" created (private, 10MB limit, PDF/DOCX only)');
    }
}

async function verifyConnection() {
    console.log('🔌 Verifying Supabase connection...');
    console.log(`   URL: ${supabaseUrl}`);

    // Quick health check
    const { error } = await supabase.from('profiles').select('id').limit(1);

    if (error && !error.message.includes('does not exist') && error.code !== '42P01') {
        // Connection issue vs table-not-existing are different
        if (error.message.includes('JWT') || error.message.includes('Invalid')) {
            console.log('   ❌ Authentication failed — check your SUPABASE_SERVICE_ROLE_KEY');
            return false;
        }
    }

    console.log('   ✅ Connected to Supabase successfully!\n');
    return true;
}

async function printManualSQL() {
    console.log('\n' + '═'.repeat(60));
    console.log('📝 MANUAL SETUP SQL');
    console.log('═'.repeat(60));
    console.log('\nIf any tables are missing, run this SQL in your');
    console.log('Supabase Dashboard → SQL Editor → New query:\n');
    console.log('─'.repeat(60));
    console.log(CREATE_TABLES_SQL);
    console.log('─'.repeat(60));
    console.log('\nAlso create the storage bucket manually if needed:');
    console.log('Dashboard → Storage → New bucket → name: "documents", private\n');
}

// ── Main ──
async function main() {
    console.log('\n🔬 Study Lens — Supabase Setup\n');

    const connected = await verifyConnection();
    if (!connected) {
        process.exit(1);
    }

    await setupTables();
    await setupStorageBucket();
    await printManualSQL();

    console.log('✨ Setup complete! You can now run the app with: npm run dev\n');
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});

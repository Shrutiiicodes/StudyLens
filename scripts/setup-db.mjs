import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function checkAndCreateTable(tableName, testInsert, columns) {
    console.log(`\nChecking table: ${tableName}...`);

    // Try to query the table
    const { error } = await supabase.from(tableName).select('*').limit(1);

    if (error && error.code === '42P01') {
        console.log(`Table "${tableName}" does not exist.`);
        console.log(`Please create it in the Supabase Dashboard > SQL Editor.`);
        console.log(`Columns needed: ${columns}`);
        return false;
    } else if (error) {
        console.log(`Error querying "${tableName}": ${error.message}`);
        return false;
    } else {
        console.log(`Table "${tableName}" exists!`);
        return true;
    }
}

async function tryCreateViaPOST(tableName, sampleRow) {
    console.log(`  Attempting to create initial row in "${tableName}" to verify schema...`);
    const { data, error } = await supabase.from(tableName).insert(sampleRow).select();
    if (error) {
        console.log(`Insert test failed: ${error.message} (code: ${error.code})`);
        return false;
    }
    // Clean up test row
    if (data && data[0] && data[0].id) {
        await supabase.from(tableName).delete().eq('id', data[0].id);
        console.log(`Schema verified and test row cleaned up.`);
    }
    return true;
}

async function main() {
    console.log('Study Lens Database Setup');
    console.log('============================\n');

    const tables = [
        {
            name: 'profiles',
            columns: 'id (uuid PK), user_id (text), full_name (text), email (text), grade (int), created_at (timestamptz)',
        },
        {
            name: 'concepts',
            columns: 'id (uuid PK), user_id (text), title (text), source_document (text), created_at (timestamptz)',
        },
        {
            name: 'mastery',
            columns: 'id (uuid PK), user_id (text), concept_id (uuid FK->concepts), mastery_score (float), last_updated (timestamptz)',
        },
        {
            name: 'attempts',
            columns: 'id (uuid PK), user_id (text), concept_id (uuid FK->concepts), question_id (text), correct (bool), difficulty (int), cognitive_level (int), time_taken (float), confidence (float), created_at (timestamptz)',
        },
    ];

    const missing = [];

    for (const table of tables) {
        const exists = await checkAndCreateTable(table.name, null, table.columns);
        if (!exists) missing.push(table);
    }

    if (missing.length > 0) {
        console.log('\n\nSQL to create missing tables:');
        console.log('================================');
        console.log('Copy and paste this into Supabase Dashboard > SQL Editor:\n');

        const sql = `
-- Profiles table
CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  full_name text,
  email text,
  grade integer DEFAULT 6,
  created_at timestamptz DEFAULT now()
);

-- Concepts table  
CREATE TABLE IF NOT EXISTS concepts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  title text NOT NULL,
  source_document text,
  created_at timestamptz DEFAULT now()
);

-- Mastery table
CREATE TABLE IF NOT EXISTS mastery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  concept_id uuid REFERENCES concepts(id) ON DELETE CASCADE,
  mastery_score float DEFAULT 0,
  current_stage text DEFAULT 'diagnostic',
  last_updated timestamptz DEFAULT now()
);

--sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    concept_id uuid REFERENCES concepts(id) ON DELETE CASCADE,
    mode text NOT NULL,
    score integer DEFAULT 0,
    passed boolean DEFAULT false,
    created_at timestamptz DEFAULT now()
  ),

-- Attempts table
CREATE TABLE IF NOT EXISTS attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  concept_id uuid REFERENCES concepts(id) ON DELETE CASCADE,
  question_id text,
  correct boolean DEFAULT false,
  difficulty integer DEFAULT 1,
  cognitive_level integer DEFAULT 1,
  time_taken float DEFAULT 0,
  confidence float DEFAULT 0.5,
  mode text DEFAULT 'diagnostic',
  session_id uuid,
  created_at timestamptz DEFAULT now()
);

-- Disable RLS for development (enable in production with proper policies)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mastery ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES sessions(id);
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'diagnostic';

-- Allow service role full access
CREATE POLICY "Service role full access" ON profiles FOR ALL USING (true);
CREATE POLICY "Service role full access" ON concepts FOR ALL USING (true);
CREATE POLICY "Service role full access" ON mastery FOR ALL USING (true);
CREATE POLICY "Service role full access" ON attempts FOR ALL USING (true);
`;

        console.log(sql);
    } else {
        console.log('\n\nAll tables exist! Database is ready.');
    }
}

main().catch(console.error);

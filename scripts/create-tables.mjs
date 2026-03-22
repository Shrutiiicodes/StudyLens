// Run SQL via Supabase Management API
// Usage: node scripts/create-tables.mjs

const SUPABASE_PROJECT_REF = 'osefyqpvuvaswvorxycn';
const SERVICE_ROLE_KEY = 'sb_secret_WjGrzzVN2TNFxJEtKbT05Q_8aFWABIM';

const statements = [
    // Profiles
    `CREATE TABLE IF NOT EXISTS profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    full_name text,
    email text,
    grade integer DEFAULT 6,
    created_at timestamptz DEFAULT now()
  )`,

    // Concepts
    `CREATE TABLE IF NOT EXISTS concepts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    title text NOT NULL,
    source_document text,
    created_at timestamptz DEFAULT now()
  )`,

    // Mastery
    `CREATE TABLE IF NOT EXISTS mastery (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    concept_id uuid REFERENCES concepts(id) ON DELETE CASCADE,
    mastery_score float DEFAULT 0,
    last_updated timestamptz DEFAULT now()
  )`,

    // Attempts
    `CREATE TABLE IF NOT EXISTS attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    concept_id uuid REFERENCES concepts(id) ON DELETE CASCADE,
    question_id text,
    correct boolean DEFAULT false,
    difficulty integer DEFAULT 1,
    cognitive_level integer DEFAULT 1,
    time_taken float DEFAULT 0,
    confidence float DEFAULT 0.5,
    created_at timestamptz DEFAULT now()
  )`,

    // RLS policies
    `ALTER TABLE profiles ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE concepts ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE mastery ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE attempts ENABLE ROW LEVEL SECURITY`,

    `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'Allow all for service role') THEN
      CREATE POLICY "Allow all for service role" ON profiles FOR ALL USING (true);
    END IF;
  END $$`,
    `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'concepts' AND policyname = 'Allow all for service role') THEN
      CREATE POLICY "Allow all for service role" ON concepts FOR ALL USING (true);
    END IF;
  END $$`,
    `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'mastery' AND policyname = 'Allow all for service role') THEN
      CREATE POLICY "Allow all for service role" ON mastery FOR ALL USING (true);
    END IF;
  END $$`,
    `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'attempts' AND policyname = 'Allow all for service role') THEN
      CREATE POLICY "Allow all for service role" ON attempts FOR ALL USING (true);
    END IF;
  END $$`,
];

async function runSQL(sql) {
    const url = `https://${SUPABASE_PROJECT_REF}.supabase.co/rest/v1/rpc/`;

    // Try the SQL API endpoint used by Supabase Studio
    const res = await fetch(`https://${SUPABASE_PROJECT_REF}.supabase.co/sql`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ query: sql }),
    });
    return { status: res.status, body: await res.text() };
}

async function main() {
    console.log('🔧 Creating Study Lens database tables...\n');

    for (const sql of statements) {
        const label = sql.substring(0, 60).replace(/\n/g, ' ');
        process.stdout.write(`  Running: ${label}... `);
        const result = await runSQL(sql);
        if (result.status >= 200 && result.status < 300) {
            console.log('✅');
        } else {
            console.log(`❌ (${result.status})`);
            console.log(`    ${result.body.substring(0, 200)}`);
        }
    }

    console.log('\nDone!');
}

main().catch(console.error);

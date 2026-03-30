
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

function loadEnv() {
    const envPath = path.join(__dirname, '..', '.env.local');
    if (!fs.existsSync(envPath)) {
        console.error('.env.local not found!');
        process.exit(1);
    }

    const envContent = fs.readFileSync(envPath, 'utf-8');
    for (const line of envContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;
        const key = trimmed.substring(0, eqIndex).trim();
        const value = trimmed.substring(eqIndex + 1).trim().replace(/^["'](.*)["']$/, '$1'); // Remove quotes
        process.env[key] = value;
    }
}

loadEnv();

async function testUpload() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    console.log('Using URL:', url);
    // console.log('Using Key:', key); // SECURITY: Be careful with secrets

    if (!url || !key) {
        console.error('Missing env vars');
        return;
    }

    const supabase = createClient(url, key);

    const testContent = new Uint8Array(Buffer.from('test pdf content'));
    const userId = '00000000-0000-0000-0000-000000000000';
    const filePath = `uploads/${userId}/${Date.now()}_test.pdf`;

    console.log('Testing upload to:', filePath);

    try {
        const { data, error } = await supabase.storage
            .from('documents')
            .upload(filePath, testContent, {
                contentType: 'application/pdf',
                upsert: true
            });

        if (error) {
            console.error('Upload failed with message:', error.message);
            console.error('Full error:', error);
        } else {
            console.log('Upload successful:', data);
        }
    } catch (err) {
        console.error('Crash during upload:', err);
    }
}

testUpload();

// ============================================================
//  PlateletWatch — Supabase Configuration
//  Replace the two values below with your project credentials.
//  Find them in: Supabase Dashboard → Project Settings → API
// ============================================================

const SUPABASE_URL      = 'https://ugrlnucoipgotugbneto.supabase.co';       // e.g. https://abcdefgh.supabase.co
const SUPABASE_ANON_KEY = 'sb_publishable_6xCVh2xhax7VZCuve98ckw_n0_1_Yhi';  // public anon key (safe for browser)

// Creates and exports the Supabase client as a global variable.
// Every page loads this file after the Supabase CDN script.
const { createClient } = supabase;
const _supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

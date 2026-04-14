import dotenv from 'dotenv';
dotenv.config();

export const config = {
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseKey: process.env.SUPABASE_SERVICE_KEY!,
  port: parseInt(process.env.PORT || '3000'),
  version: process.env.REPID_ENGINE_VERSION || '1.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
};

if (!config.supabaseUrl || !config.supabaseKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
}

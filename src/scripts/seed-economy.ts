import { db } from '../db';

async function seedEconomy() {
  console.log('Seeding economic staking and sponsorship network (beyond N=1)...');

  // Using valid IDs from trinity_agents table to satisfy the foreign key constraint:
  // HDM, GCM, TORCH, MEL, VERITAS, NEXUS, APM, ANTIGRAV

  const stakesToInsert = [
    {
      staker_agent: 'HDM',
      target_model: 'default',
      dimension: 'general',
      stake_amount: 80 * 1_000_000, // 80 USDC in micro-USDC
      status: 'active',
      created_at: new Date().toISOString()
    },
    {
      staker_agent: 'GCM',
      target_model: 'default',
      dimension: 'general',
      stake_amount: 35 * 1_000_000, // 35 USDC in micro-USDC
      status: 'active',
      created_at: new Date().toISOString()
    },
    {
      staker_agent: 'TORCH',
      target_model: 'default',
      dimension: 'general',
      stake_amount: 50 * 1_000_000, // 50 USDC in micro-USDC
      status: 'active',
      created_at: new Date().toISOString()
    }
  ];

  const sponsorshipsToInsert = [
    {
      sponsor_agent: 'HDM',
      sponsored_agent: 'GCM',
      collateral_usdc: 150.0,
      granted_authority_usdc: 50.0,
      collateral_ratio: 3.0,
      sponsor_repid_at_start: 1000,
      status: 'active',
      created_at: new Date().toISOString()
    },
    {
      sponsor_agent: 'GCM',
      sponsored_agent: 'TORCH',
      collateral_usdc: 120.0,
      granted_authority_usdc: 40.0,
      collateral_ratio: 3.0,
      sponsor_repid_at_start: 580,
      status: 'active',
      created_at: new Date().toISOString()
    },
    {
      sponsor_agent: 'TORCH',
      sponsored_agent: 'NEXUS',
      collateral_usdc: 90.0,
      granted_authority_usdc: 30.0,
      collateral_ratio: 3.0,
      sponsor_repid_at_start: 850,
      status: 'active',
      created_at: new Date().toISOString()
    }
  ];

  try {
    // 1. Insert Stakes
    console.log('Inserting stakes...');
    for (const stake of stakesToInsert) {
      // Check if already exists to prevent duplicate seeding
      const { data: existing } = await db
        .from('agent_stakes')
        .select('id')
        .eq('staker_agent', stake.staker_agent)
        .eq('status', 'active')
        .limit(1);

      if (existing && existing.length > 0) {
        console.log(`Stake for ${stake.staker_agent} already exists, skipping...`);
        continue;
      }

      const { data, error } = await db.from('agent_stakes').insert(stake).select('*');
      if (error) {
        throw new Error(`Failed to insert stake for ${stake.staker_agent}: ${error.message}`);
      }
      console.log(`Inserted stake for ${stake.staker_agent}:`, data);
    }

    // 2. Insert Sponsorships
    console.log('Inserting sponsorships...');
    for (const sponsor of sponsorshipsToInsert) {
      // Check if already exists
      const { data: existing } = await db
        .from('sponsorship_records')
        .select('id')
        .eq('sponsor_agent', sponsor.sponsor_agent)
        .eq('sponsored_agent', sponsor.sponsored_agent)
        .eq('status', 'active')
        .limit(1);

      if (existing && existing.length > 0) {
        console.log(`Sponsorship by ${sponsor.sponsor_agent} for ${sponsor.sponsored_agent} already exists, skipping...`);
        continue;
      }

      const { data, error } = await db.from('sponsorship_records').insert(sponsor).select('*');
      if (error) {
        throw new Error(`Failed to insert sponsorship by ${sponsor.sponsor_agent}: ${error.message}`);
      }
      console.log(`Inserted sponsorship by ${sponsor.sponsor_agent} for ${sponsor.sponsored_agent}:`, data);
    }

    console.log('Economic seeding complete!');
  } catch (error: any) {
    console.error('Error during economic seeding:', error.message);
  }
}

seedEconomy();

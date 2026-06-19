/**
 * XC Sprint — infra-health probe (Upstash/Dragonfly/R2/KV).
 * Read endpoints/keys from env only — no hardcoded secrets.
 *
 * Usage: npx ts-node scripts/verify-infra.ts
 */
import { getRedisClient, closeRedisClient } from '../src/clients/redis-client';

type ProbeResult = { service: string; status: 'green' | 'red' | 'skip'; latency_ms: number; detail: string };

const results: ProbeResult[] = [];

function record(r: ProbeResult) {
  results.push(r);
  const icon = r.status === 'green' ? '🟢' : r.status === 'red' ? '🔴' : '⚪';
  console.log(`${icon} ${r.service}: ${r.status} (${r.latency_ms}ms) — ${r.detail}`);
}

async function probeDragonflyRedis(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) {
    record({ service: 'Dragonfly/Redis (REDIS_URL)', status: 'skip', latency_ms: 0, detail: 'REDIS_URL unset' });
    return;
  }
  const t0 = Date.now();
  const key = `infra:probe:${Date.now()}`;
  try {
    const client = getRedisClient();
    await client.set(key, 'ok', 'EX', 30);
    const v = await client.get(key);
    await client.del(key);
    if (v === 'ok') {
      record({ service: 'Dragonfly/Redis', status: 'green', latency_ms: Date.now() - t0, detail: 'SET/GET roundtrip OK' });
    } else {
      record({ service: 'Dragonfly/Redis', status: 'red', latency_ms: Date.now() - t0, detail: `GET mismatch: ${v}` });
    }
  } catch (e: any) {
    record({ service: 'Dragonfly/Redis', status: 'red', latency_ms: Date.now() - t0, detail: e?.message ?? String(e) });
  } finally {
    await closeRedisClient().catch(() => {});
  }
}

async function probeUpstash(): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    record({ service: 'Upstash Redis REST', status: 'skip', latency_ms: 0, detail: 'UPSTASH_REDIS_REST_URL/TOKEN unset' });
    return;
  }
  const t0 = Date.now();
  const key = `infra:probe:${Date.now()}`;
  try {
    const setRes = await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent('ok')}?EX=30`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const getRes = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const getJson: any = await getRes.json().catch(() => ({}));
    if (setRes.ok && getRes.ok && getJson?.result === 'ok') {
      record({ service: 'Upstash Redis REST', status: 'green', latency_ms: Date.now() - t0, detail: 'SET/GET roundtrip OK' });
    } else {
      record({ service: 'Upstash Redis REST', status: 'red', latency_ms: Date.now() - t0, detail: `HTTP set=${setRes.status} get=${getRes.status}` });
    }
  } catch (e: any) {
    record({ service: 'Upstash Redis REST', status: 'red', latency_ms: Date.now() - t0, detail: e?.message ?? String(e) });
  }
}

async function probeCloudflareR2(): Promise<void> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID || process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY || process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME || process.env.CLOUDFLARE_R2_BUCKET;
  if (!accountId || !accessKey || !secretKey || !bucket) {
    record({
      service: 'Cloudflare R2',
      status: 'skip',
      latency_ms: 0,
      detail: 'CLOUDFLARE_ACCOUNT_ID + R2 keys + bucket unset',
    });
    return;
  }
  // Full S3-compatible put/get requires @aws-sdk/client-s3 — report config presence only if SDK absent
  try {
    const { S3Client, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const t0 = Date.now();
    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });
    const objectKey = `infra-probe/${Date.now()}.txt`;
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: 'ok' }));
    const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
    const body = await got.Body?.transformToString();
    if (body === 'ok') {
      record({ service: 'Cloudflare R2', status: 'green', latency_ms: Date.now() - t0, detail: `put/get ${objectKey} OK` });
    } else {
      record({ service: 'Cloudflare R2', status: 'red', latency_ms: Date.now() - t0, detail: 'get body mismatch' });
    }
  } catch (e: any) {
    if (String(e?.message || e).includes('Cannot find module')) {
      record({ service: 'Cloudflare R2', status: 'skip', latency_ms: 0, detail: 'env present; @aws-sdk/client-s3 not installed for live probe' });
    } else {
      record({ service: 'Cloudflare R2', status: 'red', latency_ms: 0, detail: e?.message ?? String(e) });
    }
  }
}

async function probeCloudflareKv(): Promise<void> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const namespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
  if (!accountId || !apiToken || !namespaceId) {
    record({
      service: 'Cloudflare KV',
      status: 'skip',
      latency_ms: 0,
      detail: 'CLOUDFLARE_ACCOUNT_ID/API_TOKEN/KV_NAMESPACE_ID unset',
    });
    return;
  }
  const t0 = Date.now();
  const key = `infra-probe-${Date.now()}`;
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
  try {
    const put = await fetch(base, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'text/plain' },
      body: 'ok',
    });
    const get = await fetch(base, { headers: { Authorization: `Bearer ${apiToken}` } });
    const body = await get.text();
    if (put.ok && get.ok && body === 'ok') {
      record({ service: 'Cloudflare KV', status: 'green', latency_ms: Date.now() - t0, detail: 'PUT/GET OK' });
    } else {
      record({ service: 'Cloudflare KV', status: 'red', latency_ms: Date.now() - t0, detail: `put=${put.status} get=${get.status}` });
    }
  } catch (e: any) {
    record({ service: 'Cloudflare KV', status: 'red', latency_ms: Date.now() - t0, detail: e?.message ?? String(e) });
  }
}

async function main() {
  console.log('=== infra-health probe ===');
  await probeDragonflyRedis();
  await probeUpstash();
  await probeCloudflareR2();
  await probeCloudflareKv();
  const green = results.filter((r) => r.status === 'green').length;
  const red = results.filter((r) => r.status === 'red').length;
  const skip = results.filter((r) => r.status === 'skip').length;
  console.log(`\nSUMMARY: green=${green} red=${red} skip=${skip}`);
  process.exit(red > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
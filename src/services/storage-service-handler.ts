import { ServiceHandlerBase } from './service-handler-base';
import { db } from '../db';
import { createHash } from 'crypto';
import type { ServiceContractRow } from '../types';

interface StoragePayload {
  content: string;      // base64 OR utf-8 content to store
  content_type?: 'text' | 'binary';  // base64 if 'binary'
  mime_type?: string;
  retention_days?: number;
}

export class StorageServiceHandler extends ServiceHandlerBase {
  protected readonly serviceType = 'decentralized_storage';

  protected async fulfill(contract: ServiceContractRow): Promise<Record<string, unknown>> {
    const payload = contract.payload as StoragePayload;

    // Decode content
    const contentBuffer = payload.content_type === 'binary'
      ? Buffer.from(payload.content, 'base64')
      : Buffer.from(payload.content, 'utf-8');

    // Content-addressed: hash determines storage path
    const contentHash = createHash('sha256').update(contentBuffer).digest('hex');
    const storagePath = `${contentHash.substring(0, 2)}/${contentHash.substring(2, 4)}/${contentHash}`;
    const bucketName = 'artifact-storage';

    // Check if content already exists (dedup)
    const { data: existing } = await db
      .from('storage_contracts')
      .select('id, storage_path')
      .eq('content_hash', contentHash)
      .is('deleted_at', null)
      .maybeSingle();

    if (existing) {
      // Content already stored — reference it
      // Create new storage_contracts row for THIS contract pointing to existing path
      const { data: newRow, error } = await db.from('storage_contracts').insert({
        service_contract_id: contract.id,
        content_hash: contentHash,
        content_size_bytes: contentBuffer.length,
        storage_path: existing.storage_path,
        bucket_name: bucketName,
        mime_type: payload.mime_type ?? 'application/octet-stream',
        retention_until: payload.retention_days
          ? new Date(Date.now() + payload.retention_days * 86400_000).toISOString()
          : null,
        buyer_agent_id: contract.buyer_agent_id,
        provider_agent_id: contract.provider_agent_id,
        metadata: { dedup_source: existing.id },
      }).select().single();

      if (error) throw new Error(`storage_contracts insert failed: ${error.message}`);

      return {
        content_hash: contentHash,
        storage_path: existing.storage_path,
        bucket_name: bucketName,
        size_bytes: contentBuffer.length,
        dedup: true,
        storage_contract_id: newRow.id,
        contract_id: contract.id,
        stored_at: new Date().toISOString(),
      };
    }

    // New content — upload to Supabase bucket
    const { error: uploadErr } = await db.storage
      .from(bucketName)
      .upload(storagePath, contentBuffer, {
        contentType: payload.mime_type ?? 'application/octet-stream',
        upsert: false,
      });

    if (uploadErr) {
      console.error(`[storage] upload failed for ${contentHash}:`, uploadErr, new Error().stack);
      throw new Error(`Storage upload failed: ${uploadErr.message}`);
    }

    // Record in storage_contracts
    const { data: newRow, error: dbErr } = await db.from('storage_contracts').insert({
      service_contract_id: contract.id,
      content_hash: contentHash,
      content_size_bytes: contentBuffer.length,
      storage_path: storagePath,
      bucket_name: bucketName,
      mime_type: payload.mime_type ?? 'application/octet-stream',
      retention_until: payload.retention_days
        ? new Date(Date.now() + payload.retention_days * 86400_000).toISOString()
        : null,
      buyer_agent_id: contract.buyer_agent_id,
      provider_agent_id: contract.provider_agent_id,
    }).select().single();

    if (dbErr) {
      console.error(`[storage] db insert failed:`, dbErr, new Error().stack);
      throw new Error(`storage_contracts insert failed: ${dbErr.message}`);
    }

    return {
      content_hash: contentHash,
      storage_path: storagePath,
      bucket_name: bucketName,
      size_bytes: contentBuffer.length,
      dedup: false,
      storage_contract_id: newRow.id,
      contract_id: contract.id,
      stored_at: new Date().toISOString(),
    };
  }
}

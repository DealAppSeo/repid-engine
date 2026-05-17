import { StorageServiceHandler } from '../../src/services/storage-service-handler';
import { db } from '../../src/db';

jest.mock('../../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: null }),
    insert: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { id: 'mock-storage-contract-id' }, error: null }),
    storage: {
      from: jest.fn().mockReturnThis(),
      upload: jest.fn().mockResolvedValue({ error: null }),
    }
  }
}));

describe('StorageServiceHandler', () => {
  let handler: any;

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new StorageServiceHandler();
  });

  it('uploads new content and records it', async () => {
    const contract = {
      id: 'contract-1',
      payload: {
        content: 'hello world',
        content_type: 'text',
      },
      buyer_agent_id: 'buyer-1',
      provider_agent_id: 'provider-1'
    };

    const res = await handler.fulfill(contract);
    expect(res.size_bytes).toBe(11);
    expect(res.dedup).toBe(false);
    expect(db.storage.from).toHaveBeenCalledWith('artifact-storage');
  });

  it('deduplicates existing content', async () => {
    (db.maybeSingle as jest.Mock).mockResolvedValueOnce({
      data: { id: 'existing-storage-id', storage_path: 'mock/path' }
    });

    const contract = {
      id: 'contract-2',
      payload: {
        content: 'hello world',
        content_type: 'text',
      },
      buyer_agent_id: 'buyer-1',
      provider_agent_id: 'provider-1'
    };

    const res = await handler.fulfill(contract);
    expect(res.size_bytes).toBe(11);
    expect(res.dedup).toBe(true);
    expect(db.storage.from).not.toHaveBeenCalled();
  });
});

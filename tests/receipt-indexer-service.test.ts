/**
 * Happy-path test for the receipt-indexer service tick. Mocks ethers provider
 * + Supabase client and verifies one ReceiptRevealed event flows through
 * indexOnce correctly: hyperdag_receipts row gets contract_* backfilled, and
 * a trinity_tasks/receipt_validation row is enqueued.
 *
 * Sprint asked for the test under src/services/__tests__/. Placed under
 * tests/ instead because jest.config.js has roots: ['<rootDir>/tests'] —
 * src/**\/__tests__/ files are silently excluded. See CLAUDE.md "Test layout".
 */
import { ethers } from 'ethers';
import { indexOnce, RECEIPT_EVENT_ABI } from '../src/services/receipt-indexer';

const RECEIPT_INTERFACE = new ethers.Interface(RECEIPT_EVENT_ABI as unknown as string[]);

function encodeReceiptRevealedLog(args: {
  receiptId: string;
  agentId: bigint;
  x402PaymentHash: string;
  taskHash: string;
  resultHash: string;
  repIdCommitment: string;
  halOutputHash: string;
  halDofVersion: number;
  halCommaBftVerdict: number;
  receiptUriHash: string;
  receiptContentHash: string;
  scoreVersion: bigint;
  committer: string;
  timestamp: bigint;
}, blockNumber: number, transactionHash: string): ethers.Log {
  const fragment = RECEIPT_INTERFACE.getEvent('ReceiptRevealed');
  if (!fragment) throw new Error('ReceiptRevealed fragment missing');

  const indexedTopics = [
    fragment.topicHash,
    ethers.zeroPadValue(args.receiptId, 32),
    ethers.zeroPadValue(ethers.toBeHex(args.agentId), 32),
    ethers.zeroPadValue(args.x402PaymentHash, 32)
  ];

  const nonIndexedTypes = [
    'bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint8', 'uint8', 'bytes32', 'bytes32', 'uint256', 'address', 'uint64'
  ];
  const nonIndexedValues = [
    args.taskHash, args.resultHash, args.repIdCommitment, args.halOutputHash,
    args.halDofVersion, args.halCommaBftVerdict, args.receiptUriHash, args.receiptContentHash,
    args.scoreVersion, args.committer, args.timestamp
  ];
  const data = ethers.AbiCoder.defaultAbiCoder().encode(nonIndexedTypes, nonIndexedValues);

  return {
    address: '0x6f3519cb9d0c2edc908e9d956538f20eb51b06cf',
    blockNumber,
    blockHash: '0x' + 'aa'.repeat(32),
    transactionHash,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
    topics: indexedTopics,
    data
  } as unknown as ethers.Log;
}

describe('indexOnce — happy path', () => {
  it('processes a ReceiptRevealed event end-to-end', async () => {
    const onChainReceiptId = '0x' + '11'.repeat(32);
    const receiptContentHash = '0x' + '22'.repeat(32);
    const offChainReceiptId = '0x' + '33'.repeat(32);
    const receiptUri = 'https://example.test/receipt/abc';
    const txHash = '0x' + '44'.repeat(32);
    const blockNumber = 41037121;

    const log = encodeReceiptRevealedLog({
      receiptId: onChainReceiptId,
      agentId: 3749n,
      x402PaymentHash: '0x' + '55'.repeat(32),
      taskHash: '0x' + '66'.repeat(32),
      resultHash: '0x' + '77'.repeat(32),
      repIdCommitment: '0x' + '88'.repeat(32),
      halOutputHash: '0x' + '99'.repeat(32),
      halDofVersion: 5,
      halCommaBftVerdict: 0,
      receiptUriHash: '0x' + 'aa'.repeat(32),
      receiptContentHash,
      scoreVersion: 5n,
      committer: '0x7b84cce55502d393daa6533285ef3e2f8d3a1326',
      timestamp: 1746384000n
    }, blockNumber, txHash);

    const provider = {
      getLogs: jest.fn().mockResolvedValue([log])
    } as unknown as ethers.JsonRpcProvider;

    const updateCalls: Array<Record<string, unknown>> = [];
    const insertCalls: Array<Record<string, unknown>> = [];
    const lookupCalls: Array<Record<string, unknown>> = [];

    const supabase = {
      from(table: string) {
        if (table === 'hyperdag_receipts') {
          return {
            update(payload: Record<string, unknown>) {
              return {
                eq(_col: string, val: unknown) {
                  return {
                    select(_cols: string) {
                      updateCalls.push({ payload, eqVal: val });
                      return Promise.resolve({
                        data: [{ receipt_id: offChainReceiptId, receipt_uri: receiptUri }],
                        error: null
                      });
                    }
                  };
                }
              };
            }
          };
        }
        if (table === 'trinity_tasks') {
          return {
            select(_cols: string) {
              return {
                eq(_col: string, _val: unknown) {
                  return {
                    contains(_metaCol: string, val: Record<string, unknown>) {
                      return {
                        limit(_n: number) {
                          lookupCalls.push({ contains: val });
                          return Promise.resolve({ data: [], error: null });
                        }
                      };
                    }
                  };
                }
              };
            },
            insert(payload: Record<string, unknown>) {
              insertCalls.push(payload);
              return Promise.resolve({ data: null, error: null });
            }
          };
        }
        throw new Error(`unexpected table: ${table}`);
      }
    } as never;

    const result = await indexOnce(blockNumber, blockNumber, {
      provider,
      contractAddress: '0x6f3519cb9d0c2edc908e9d956538f20eb51b06cf',
      supabase
    });

    expect(result.eventsProcessed).toBe(1);
    expect(result.perEvent.revealed).toBe(1);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.payload).toMatchObject({
      contract_receipt_id: onChainReceiptId,
      contract_tx_hash: txHash,
      contract_block_number: blockNumber
    });
    expect(updateCalls[0]?.eqVal).toBe(receiptContentHash);

    expect(lookupCalls).toHaveLength(1);
    expect(lookupCalls[0]?.contains).toEqual({ receiptId: offChainReceiptId });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      task_type: 'receipt_validation',
      status: 'pending',
      priority: 90
    });
    expect((insertCalls[0]?.metadata as Record<string, unknown>)?.receiptId).toBe(offChainReceiptId);
    expect((insertCalls[0]?.metadata as Record<string, unknown>)?.contractReceiptId).toBe(onChainReceiptId);
  });

  it('returns zero events for an empty range', async () => {
    const provider = {
      getLogs: jest.fn().mockResolvedValue([])
    } as unknown as ethers.JsonRpcProvider;

    const supabase = { from: jest.fn() } as never;

    const result = await indexOnce(100, 100, {
      provider,
      contractAddress: '0x6f3519cb9d0c2edc908e9d956538f20eb51b06cf',
      supabase
    });

    expect(result.eventsProcessed).toBe(0);
    expect(result.perEvent).toEqual({ revealed: 0, invalidated: 0, committed: 0 });
  });
});

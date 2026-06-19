import pg from 'pg';
import { config } from 'dotenv';
import { keccak256, toUtf8Bytes, concat, getBytes, AbiCoder, Interface, ZeroHash, solidityPackedKeccak256 } from 'ethers';
config();

function epochLeaf(commitment) {
  return keccak256(toUtf8Bytes(commitment));
}
function pairHash(a, b) {
  return keccak256(concat([getBytes(a), getBytes(b)]));
}
function buildMerkleRoot(leaves) {
  if (!leaves.length) return ZeroHash;
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(pairHash(left, right));
    }
    level = next;
  }
  return level[0];
}

const EAS_SCHEMA_STRING = 'string domain,bytes32 merkleRoot,string epoch,uint64 proofCount,uint64 firstId,uint64 lastId';
const ANCHOR_DOMAIN = 'repid-postcard-epoch';
const EAS_CONTRACT = '0x4200000000000000000000000000000000000021';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const afterId = 56823;
const start = '2026-06-17T00:00:00.000Z';
const end = '2026-06-18T00:00:00.000Z';

const rows = await c.query(
  `SELECT id, zk_commitment FROM repid_zkp_proofs
   WHERE proof_type='POSTCARD' AND zk_commitment IS NOT NULL
     AND created_at >= $1 AND created_at < $2 AND id > $3
     AND is_real = true
   ORDER BY id ASC`,
  [start, end, afterId],
);

const ids = rows.rows.map((r) => r.id);
const leaves = rows.rows.map((r) => epochLeaf(r.zk_commitment));
const root = buildMerkleRoot(leaves);
const distinct = new Set(rows.rows.map((r) => r.zk_commitment)).size;

const schemaUid = solidityPackedKeccak256(['string', 'address', 'bool'], [EAS_SCHEMA_STRING, '0x0000000000000000000000000000000000000000', true]);
const encodedData = AbiCoder.defaultAbiCoder().encode(
  ['string', 'bytes32', 'string', 'uint64', 'uint64', 'uint64'],
  [ANCHOR_DOMAIN, root, '2026-06-17', rows.rows.length, ids[0] ?? 0, ids[ids.length - 1] ?? 0],
);
const iface = new Interface(['function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) external payable returns (bytes32)']);
const attestCalldata = iface.encodeFunctionData('attest', [{
  schema: schemaUid,
  data: { recipient: '0x0000000000000000000000000000000000000000', expirationTime: 0n, revocable: true, refUID: ZeroHash, data: encodedData, value: 0n },
}]);

console.log(JSON.stringify({
  epoch: '2026-06-17',
  afterId,
  is_real_filter: true,
  proof_count: rows.rows.length,
  distinct_commitments: distinct,
  first_id: ids[0] ?? null,
  last_id: ids[ids.length - 1] ?? null,
  merkle_root: root,
  schema_uid: schemaUid,
  attest_calldata_len: attestCalldata.length,
  sean_cast_send: `cast send ${EAS_CONTRACT} ${attestCalldata} --rpc-url $RPC --private-key $PK`,
}, null, 2));
await c.end();
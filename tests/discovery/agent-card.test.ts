import request from 'supertest';
import app from '../../src/index';

describe('Agent Card Routes', () => {
  it('GET /.well-known/agent.json returns 200', async () => {
    const res = await request(app).get('/.well-known/agent.json');
    expect(res.status).toBe(200);
    expect(res.body.schema_version).toBe('1.1');

    expect(res.body.agent.name).toBe('HyperDAG RepID Engine');
  });

  it('GET /agent.json returns 200 and matches', async () => {
    const res1 = await request(app).get('/.well-known/agent.json');
    const res2 = await request(app).get('/agent.json');
    expect(res2.status).toBe(200);
    expect(res2.body).toEqual(res1.body);
  });
});

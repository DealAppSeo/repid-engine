import { readFileSync } from 'node:fs';
import path from 'node:path';
import { aggregateHonestyA } from '../src/services/honesty-a';

describe('GET /api/v1/hal/honesty-a empty rows', () => {
  it('counts an empty read and reports first_pass NOT_CHECKED, never 0', () => {
    const report = aggregateHonestyA([]);
    expect(report.status).toBe('counted');
    expect(report.rows).toEqual([]);
    expect(report.first_pass).toBe('NOT_CHECKED');
    expect(report.first_pass).not.toBe(0);

    const json = JSON.stringify(report);
    expect(json).not.toContain('user_id');
    expect(json).not.toContain('claim');

    const route = readFileSync(
      path.join(__dirname, '..', 'src', 'routes', 'honesty-a.ts'),
      'utf8',
    );
    const select = route.slice(route.indexOf('.select('), route.indexOf('.gte('));
    expect(select).not.toContain('user_id');
    expect(select).not.toContain('claim');
  });
});

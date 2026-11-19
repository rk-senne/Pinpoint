import { describe, it, expect } from 'vitest';
import { generateCsv } from '../PdfKitReportRenderer.js';

describe('export screenshot links', () => {
  it('links to the annotation (authenticated route), never to the raw private object key', () => {
    const row = {
      id: '11111111-1111-4111-8111-111111111111',
      pin_number: 1, type: 'note', severity: 'major', status: 'open', body: 'b',
      author_id: 'u', author_name: 'A', author_email: null, guideline_name: null,
      created_at: '2026-11-19T00:00:00Z', page_url: 'https://example.com/', assignee_id: null,
      due_date: null, environment: null, screenshot_object_key: 'annotations/screenshots/x/secret.png',
    };
    const seen: string[] = [];
    const csv = generateCsv([row] as never, (id) => {
      seen.push(id);
      return `https://app.example/api/v1/annotations/${id}/screenshot`;
    });
    expect(seen).toEqual([row.id]);
    expect(csv).toContain(`/api/v1/annotations/${row.id}/screenshot`);
    expect(csv).not.toContain('secret.png');
  });
});

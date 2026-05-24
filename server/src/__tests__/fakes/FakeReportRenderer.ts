// FakeReportRenderer — deterministic ReportRenderer fake
// (Phase 1.5 / task 4.11.1).
//
// Returns a fixed body buffer plus content-type and filename derived from
// the requested format. Tests assert on the metadata + that the call was
// made for the right project; the body bytes are intentionally trivial.

import type {
  RenderProjectReportInput,
  RenderedReport,
  ReportRenderer,
} from '../../domain/project/ports/ReportRenderer.js';
import type { Clock } from '../../domain/shared/ports/Clock.js';

const FAKE_PDF_BODY = 'fake-pdf-report';
const FAKE_CSV_BODY = 'pin,severity,status\n';

export class FakeReportRenderer implements ReportRenderer {
  /** Public for assertion in tests. */
  readonly calls: RenderProjectReportInput[] = [];

  constructor(private readonly clock: Clock) {}

  async render(input: RenderProjectReportInput): Promise<RenderedReport> {
    this.calls.push(input);

    const exportedAt = this.clock.now().toISOString();
    if (input.format === 'pdf') {
      return {
        contentType: 'application/pdf',
        filename: `${input.project.name}-${exportedAt}.pdf`,
        body: Buffer.from(FAKE_PDF_BODY, 'utf8'),
        exportedAt,
      };
    }
    return {
      contentType: 'text/csv',
      filename: `${input.project.name}-${exportedAt}.csv`,
      body: Buffer.from(FAKE_CSV_BODY, 'utf8'),
      exportedAt,
    };
  }
}

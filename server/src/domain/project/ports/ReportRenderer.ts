// ReportRenderer outbound port (Phase 1.5 / task 4.7.10).
//
// Renders the project annotation report as either a PDF (Req 34) or a
// CSV. The adapter is the only place that imports `pdfkit` (and any
// CSV-formatting library); the domain only sees the resulting bytes plus
// the metadata needed to set HTTP headers.

import type { Project } from '../Project.js';

export type ReportFormat = 'pdf' | 'csv';

export interface RenderProjectReportInput {
  project: Project;
  format: ReportFormat;
}

export interface RenderedReport {
  /** Content-Type to put on the HTTP response. */
  contentType: string;
  /** Suggested attachment filename (without leading directory). */
  filename: string;
  /** The fully-rendered report bytes. */
  body: Buffer;
  /** ISO 8601 timestamp captured at the start of rendering, for downstream events. */
  exportedAt: string;
}

export interface ReportRenderer {
  render(input: RenderProjectReportInput): Promise<RenderedReport>;
}

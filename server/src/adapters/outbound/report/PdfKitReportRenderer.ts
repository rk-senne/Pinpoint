// PdfKitReportRenderer — outbound adapter for the `ReportRenderer` port
// (Phase 1.5 / task 4.10.1).
//
// Renders the project annotation report as either a PDF (via PDFKit)
// or a CSV. This adapter is the only place in the codebase that imports
// `pdfkit`; the domain layer only sees the rendered bytes through the
// `ReportRenderer` port.
//
// The adapter pulls the per-project annotation rows directly from
// Postgres via the supplied Knex handle so the rendering pipeline can
// stay synchronous and embed screenshots in one pass. Screenshot
// fetches go through the S3Client; failures fall back to a URL printed
// as text so the export still succeeds when an object is missing.

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Knex } from 'knex';
import PDFDocument from 'pdfkit';

import type { Project } from '../../../domain/project/Project.js';
import type {
  RenderProjectReportInput,
  RenderedReport,
  ReportRenderer,
} from '../../../domain/project/ports/ReportRenderer.js';

export interface PdfKitReportRendererConfig {
  /** Bucket the screenshot store writes to. Used for embed fetches. */
  bucket: string;
  /** Build the publicly addressable URL for an object key (fallback). */
  buildScreenshotUrl: (objectKey: string) => string;
}

interface AnnotationRow {
  id: string;
  pin_number: number;
  type: string;
  severity: string;
  status: string;
  body: string;
  author_id: string;
  author_name: string | null;
  author_email: string | null;
  guideline_name: string | null;
  created_at: Date | string;
  page_url: string;
  assignee_id: string | null;
  due_date: string | Date | null;
  environment: unknown;
  screenshot_object_key: string | null;
}

interface ParsedEnvironment {
  browserFamily: string;
  browserVersion: string | null;
  osFamily: string;
  osVersion: string | null;
  deviceType: string;
}

export class PdfKitReportRenderer implements ReportRenderer {
  constructor(
    private readonly db: Knex,
    private readonly s3Client: S3Client,
    private readonly config: PdfKitReportRendererConfig,
  ) {}

  async render(input: RenderProjectReportInput): Promise<RenderedReport> {
    const exportedAt = new Date().toISOString();

    const annotations = await this.db<AnnotationRow>('annotations')
      .leftJoin('users', 'annotations.author_id', 'users.id')
      .leftJoin('guidelines', 'annotations.guideline_id', 'guidelines.id')
      .leftJoin('pages', 'annotations.page_id', 'pages.id')
      .where('annotations.project_id', input.project.id)
      .orderBy('annotations.pin_number', 'asc')
      .select(
        'annotations.id',
        'annotations.pin_number',
        'annotations.type',
        'annotations.severity',
        'annotations.status',
        'annotations.body',
        'annotations.author_id',
        'annotations.created_at',
        'annotations.environment',
        'annotations.assignee_id',
        'annotations.due_date',
        'annotations.screenshot_object_key',
        'users.name as author_name',
        'users.email as author_email',
        'guidelines.name as guideline_name',
        'pages.url as page_url',
      );

    const filenameBase = sanitizeFilename(input.project.name);
    const stampedAt = Date.now();

    if (input.format === 'pdf') {
      const body = await this.generatePdf(input.project, annotations, exportedAt);
      return {
        contentType: 'application/pdf',
        filename: `${filenameBase}-export-${stampedAt}.pdf`,
        body,
        exportedAt,
      };
    }

    const body = Buffer.from(generateCsv(annotations, this.config.buildScreenshotUrl), 'utf8');
    return {
      contentType: 'text/csv',
      filename: `${filenameBase}-export-${stampedAt}.csv`,
      body,
      exportedAt,
    };
  }

  // ---- PDF rendering ---------------------------------------------------

  private async fetchScreenshotBytes(objectKey: string): Promise<Buffer | null> {
    try {
      const result = await this.s3Client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: objectKey }),
      );
      const bodyValue = result.Body;
      if (!bodyValue) return null;

      const maybeHelper = bodyValue as {
        transformToByteArray?: () => Promise<Uint8Array>;
      };
      if (typeof maybeHelper.transformToByteArray === 'function') {
        const bytes = await maybeHelper.transformToByteArray();
        return Buffer.from(bytes);
      }

      const stream = bodyValue as NodeJS.ReadableStream;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch {
      return null;
    }
  }

  private async generatePdf(
    project: Project,
    annotations: AnnotationRow[],
    exportDate: string,
  ): Promise<Buffer> {
    const screenshotBuffers = new Map<string, Buffer | null>();
    await Promise.all(
      annotations
        .filter((a) => a.screenshot_object_key)
        .map(async (a) => {
          const bytes = await this.fetchScreenshotBytes(a.screenshot_object_key as string);
          screenshotBuffers.set(a.id, bytes);
        }),
    );

    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(20).text(project.name, { align: 'center' });
      doc.moveDown(0.5);

      doc.fontSize(10).fillColor('#666666');
      const urls = Array.isArray(project.urls) ? project.urls.join(', ') : String(project.urls);
      doc.text(`URL: ${urls}`);
      doc.text(`Export Date: ${new Date(exportDate).toLocaleString()}`);
      doc.moveDown(1);

      const severityCounts: Record<string, number> = {
        critical: 0,
        major: 0,
        minor: 0,
        informational: 0,
      };
      for (const a of annotations) {
        if (severityCounts[a.severity] !== undefined) severityCounts[a.severity]++;
      }

      doc.fontSize(14).fillColor('#000000').text('Annotation Summary by Severity');
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor('#333333');
      doc.text(`Critical: ${severityCounts.critical}`);
      doc.text(`Major: ${severityCounts.major}`);
      doc.text(`Minor: ${severityCounts.minor}`);
      doc.text(`Informational: ${severityCounts.informational}`);
      doc.text(`Total: ${annotations.length}`);
      doc.moveDown(1);

      doc.fontSize(14).fillColor('#000000').text('Annotations');
      doc.moveDown(0.5);

      for (const a of annotations) {
        const env = parseEnvironment(a.environment);
        doc.fontSize(11).fillColor('#000000').text(`#${a.pin_number} — ${capitalize(a.type)}`);
        doc.fontSize(9).fillColor('#555555');
        doc.text(`Severity: ${capitalize(a.severity)}`);
        doc.text(`Status: ${capitalize(a.status)}`);
        doc.text(`Author: ${a.author_name ?? a.author_email ?? a.author_id}`);
        doc.text(
          `Date: ${new Date(typeof a.created_at === 'string' ? a.created_at : a.created_at.toISOString()).toLocaleString()}`,
        );
        doc.text(
          `Browser: ${env.browserFamily}${env.browserVersion ? ` ${env.browserVersion}` : ''}`,
        );
        doc.text(`OS: ${env.osFamily}${env.osVersion ? ` ${env.osVersion}` : ''}`);
        doc.text(`Device: ${env.deviceType}`);
        if (a.guideline_name) doc.text(`Guideline: ${a.guideline_name}`);
        doc.moveDown(0.2);
        doc.fontSize(10).fillColor('#000000').text(a.body);

        if (a.screenshot_object_key) {
          const bytes = screenshotBuffers.get(a.id);
          if (bytes) {
            try {
              doc.moveDown(0.3);
              doc.image(bytes, { fit: [400, 400] });
            } catch {
              doc.moveDown(0.3);
              doc
                .fontSize(9)
                .fillColor('#1d4ed8')
                .text(`Screenshot: ${this.config.buildScreenshotUrl(a.screenshot_object_key)}`);
            }
          } else {
            doc.moveDown(0.3);
            doc
              .fontSize(9)
              .fillColor('#1d4ed8')
              .text(`Screenshot: ${this.config.buildScreenshotUrl(a.screenshot_object_key)}`);
          }
        }

        doc.moveDown(0.8);
      }

      doc.end();
    });
  }
}

// ---- Helpers ----------------------------------------------------------

function generateCsv(
  annotations: AnnotationRow[],
  buildScreenshotUrl: (objectKey: string) => string,
): string {
  const headers = [
    'Pin Number',
    'Type',
    'Severity',
    'Status',
    'Body',
    'Author',
    'Created At',
    'Page URL',
    'Guideline',
    'Assignee ID',
    'Due Date',
    'Browser Family',
    'Browser Version',
    'OS Family',
    'OS Version',
    'Device Type',
    'Screenshot URL',
  ];

  const rows = annotations.map((a) => {
    const env = parseEnvironment(a.environment);
    const screenshotUrl = a.screenshot_object_key
      ? buildScreenshotUrl(a.screenshot_object_key)
      : '';
    return [
      String(a.pin_number),
      a.type,
      a.severity,
      a.status,
      a.body,
      a.author_name ?? a.author_email ?? a.author_id,
      typeof a.created_at === 'string' ? a.created_at : a.created_at.toISOString(),
      a.page_url ?? '',
      a.guideline_name ?? '',
      a.assignee_id ?? '',
      a.due_date ? (typeof a.due_date === 'string' ? a.due_date : a.due_date.toISOString()) : '',
      env.browserFamily,
      env.browserVersion ?? '',
      env.osFamily,
      env.osVersion ?? '',
      env.deviceType,
      screenshotUrl,
    ];
  });

  const csvLines = [headers, ...rows].map((row) =>
    row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','),
  );
  return csvLines.join('\n');
}

function parseEnvironment(raw: unknown): ParsedEnvironment {
  const fallback: ParsedEnvironment = {
    browserFamily: 'unknown',
    browserVersion: null,
    osFamily: 'unknown',
    osVersion: null,
    deviceType: 'desktop',
  };
  if (raw == null) return fallback;
  let env: unknown = raw;
  if (typeof raw === 'string') {
    try {
      env = JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  if (typeof env !== 'object' || env === null) return fallback;
  const e = env as Record<string, unknown>;
  return {
    browserFamily:
      typeof e.browserFamily === 'string' ? e.browserFamily : fallback.browserFamily,
    browserVersion: typeof e.browserVersion === 'string' ? e.browserVersion : null,
    osFamily: typeof e.osFamily === 'string' ? e.osFamily : fallback.osFamily,
    osVersion: typeof e.osVersion === 'string' ? e.osVersion : null,
    deviceType: typeof e.deviceType === 'string' ? e.deviceType : fallback.deviceType,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

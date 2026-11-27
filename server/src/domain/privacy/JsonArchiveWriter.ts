// JsonArchiveWriter — streams a JSON document one element at a time through a
// sink (the HTTP response in production, a string buffer in tests), enforcing
// a byte cap so an export can never exhaust server memory or bandwidth.
//
// Document shape:
//   { "meta": {...}, "<value>": ..., "<array>": [ ... ], ..., "truncated": false }
// `truncated` is the LAST member; when true at least one element was dropped
// because the cap was reached, and the consumer should ask support for an
// offline export (documented in docs/legal/DATA_RETENTION.md).

import type { ArchiveWriter } from './ports/ArchiveWriter.js';

export type ArchiveSink = (chunk: string) => Promise<void> | void;

export class JsonArchiveWriter implements ArchiveWriter {
  private bytes = 0;
  private first = true; // first member of the root object
  private firstItem = true; // first element of the open array
  private inArray = false;
  private truncated = false;
  private begun = false;

  constructor(
    private readonly sink: ArchiveSink,
    private readonly maxBytes: number,
  ) {}

  /** Bytes written so far. */
  get size(): number {
    return this.bytes;
  }

  get isTruncated(): boolean {
    return this.truncated;
  }

  private async emit(chunk: string): Promise<void> {
    this.bytes += Buffer.byteLength(chunk, 'utf8');
    await this.sink(chunk);
  }

  async begin(meta: Record<string, unknown>): Promise<void> {
    if (this.begun) throw new Error('archive already begun');
    this.begun = true;
    await this.emit(`{"meta":${JSON.stringify(meta)}`);
    this.first = false;
  }

  async value(name: string, value: unknown): Promise<void> {
    this.assertOpen(false);
    await this.emit(`,${JSON.stringify(name)}:${JSON.stringify(value ?? null)}`);
  }

  async beginArray(name: string): Promise<void> {
    this.assertOpen(false);
    this.inArray = true;
    this.firstItem = true;
    await this.emit(`,${JSON.stringify(name)}:[`);
  }

  async item(value: unknown): Promise<boolean> {
    this.assertOpen(true);
    const json = JSON.stringify(value ?? null);
    const chunk = this.firstItem ? json : `,${json}`;
    // Reserve room for the closing tokens (`]` + `,"truncated":true}`).
    if (this.truncated || this.bytes + Buffer.byteLength(chunk, 'utf8') + 32 > this.maxBytes) {
      this.truncated = true;
      return false;
    }
    this.firstItem = false;
    await this.emit(chunk);
    return true;
  }

  async endArray(): Promise<void> {
    this.assertOpen(true);
    this.inArray = false;
    await this.emit(']');
  }

  async end(): Promise<void> {
    this.assertOpen(false);
    await this.emit(`,"truncated":${this.truncated ? 'true' : 'false'}}`);
    this.begun = false;
  }

  private assertOpen(wantArray: boolean): void {
    if (!this.begun || this.first) throw new Error('archive not begun');
    if (this.inArray !== wantArray) throw new Error(wantArray ? 'no open array' : 'array still open');
  }
}

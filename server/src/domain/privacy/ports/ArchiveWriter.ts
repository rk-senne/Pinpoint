// ArchiveWriter port — incremental writer for the JSON data-export archives.
//
// The export use cases never build the whole archive in memory: the repo
// pushes one row at a time through this writer, which streams it to the HTTP
// response (or a buffer in tests) and enforces the size cap.

export interface ArchiveWriter {
  /** Write a top-level scalar/object section, e.g. `profile`. */
  value(name: string, value: unknown): Promise<void>;
  /** Open a top-level array section; every `item` goes into the open array. */
  beginArray(name: string): Promise<void>;
  /**
   * Append one element to the open array. Returns false once the size cap is
   * reached (the writer drops the element and the archive is flagged
   * `truncated`); callers should stop producing rows for that section.
   */
  item(value: unknown): Promise<boolean>;
  endArray(): Promise<void>;
}

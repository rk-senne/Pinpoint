// EnvironmentMetadata value object (Req 17 / Phase 1.5 task 4.6.1).
//
// Browser, OS, and device metadata captured per Annotation. Required on
// every Annotation per Req 17.3; the `viewport*` and `devicePixelRatio`
// fields are kept for back-compat with the legacy bug-report payload.

export type BrowserFamily =
  | 'Chrome'
  | 'Edge'
  | 'Safari'
  | 'Firefox'
  | 'Opera'
  | 'Brave'
  | 'Arc'
  | 'Other'
  | 'unknown';

export type OsFamily =
  | 'macOS'
  | 'Windows'
  | 'Linux'
  | 'iOS'
  | 'Android'
  | 'ChromeOS'
  | 'Other'
  | 'unknown';

export type DeviceType = 'desktop' | 'tablet' | 'mobile';

export interface EnvironmentMetadata {
  browserFamily: BrowserFamily;
  browserVersion: string | null;
  osFamily: OsFamily;
  osVersion: string | null;
  deviceType: DeviceType;
  userAgentRaw: string;
  // Legacy bug-report fields kept for back-compat.
  viewportWidth?: number;
  viewportHeight?: number;
  devicePixelRatio?: number;
}

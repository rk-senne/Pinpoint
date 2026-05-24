// Page entity (Req 23 / Phase 1.5 task 4.6.1).
//
// Pages are the per-URL children of a Project; annotations FK to a Page so
// the (project_id, url) pairing is canonical and the legacy `pageUrl`
// duplication can fade out over time.

export interface Page {
  id: string;
  projectId: string;
  url: string;
  title: string | null;
  createdAt: string;
}

export interface NewPage {
  projectId: string;
  url: string;
  title?: string | null;
}

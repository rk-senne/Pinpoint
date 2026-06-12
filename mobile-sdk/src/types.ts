// Minimal types for mobile clients — zero external deps.

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  urls: string[];
  status: 'active' | 'archived';
  ownerId: string;
  teamId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Annotation {
  id: string;
  projectId: string;
  pageId: string;
  pageUrl?: string;
  type: 'note' | 'suggestion' | 'guideline';
  severity: 'critical' | 'major' | 'minor' | 'informational';
  status: 'active' | 'in_progress' | 'resolved';
  body: string;
  authorId: string;
  pinNumber: number;
  assigneeId?: string;
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  annotationId: string;
  authorId: string;
  body: string;
  mentions: string[];
  createdAt: string;
}

export interface Notification {
  id: string;
  status: 'pending' | 'sent' | 'failed';
  payload: { kind: string; recipientUserId: string; [key: string]: unknown };
  createdAt: string;
  updatedAt: string;
}

export interface CreateAnnotationInput {
  pageId: string;
  type: 'note' | 'suggestion' | 'guideline';
  severity: 'critical' | 'major' | 'minor' | 'informational';
  body: string;
  target: { cssSelector: string; xpath: string; pageX: number; pageY: number; tagName: string; textSnippet: string };
  environment: {
    browserFamily: string;
    browserVersion: string | null;
    osFamily: string;
    osVersion: string | null;
    deviceType: string;
    userAgentRaw: string;
  };
  guidelineId?: string;
}

export interface UpdateAnnotationInput {
  body?: string;
  severity?: 'critical' | 'major' | 'minor' | 'informational';
  assigneeId?: string;
  dueDate?: string;
}

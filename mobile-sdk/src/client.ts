// Pinpoint Mobile SDK Client — zero runtime dependencies.

import type {
  User,
  Project,
  Annotation,
  Comment,
  Notification,
  CreateAnnotationInput,
  UpdateAnnotationInput,
} from './types.js';

export interface PinpointConfig {
  baseUrl: string;
  apiKey?: string;
  token?: string;
  onAuthRequired?: () => void;
}

export class PinpointClient {
  private config: PinpointConfig;
  private ws: WebSocket | null = null;
  private listeners: Map<string, Set<(data: unknown) => void>> = new Map();

  constructor(config: PinpointConfig) {
    this.config = { ...config };
  }

  setToken(token: string): void {
    this.config.token = token;
  }

  // --- Auth ---

  async login(email: string, password: string): Promise<{ token: string; user: User }> {
    return this.request<{ token: string; user: User }>('POST', '/auth/login', { email, password });
  }

  oauthUrl(provider: 'google' | 'github', options?: { codeChallenge?: string; redirectUri?: string }): string {
    const params = new URLSearchParams();
    if (options?.codeChallenge) {
      params.set('code_challenge', options.codeChallenge);
      params.set('code_challenge_method', 'S256');
    }
    if (options?.redirectUri) params.set('redirect_uri', options.redirectUri);
    const qs = params.toString();
    return `${this.config.baseUrl}/api/v1/auth/oauth/${provider}${qs ? `?${qs}` : ''}`;
  }

  async exchangeOAuthCode(provider: string, code: string, codeVerifier?: string): Promise<{ token: string; user: User }> {
    const params = new URLSearchParams({ code });
    if (codeVerifier) params.set('code_verifier', codeVerifier);
    return this.request<{ token: string; user: User }>('GET', `/auth/oauth/${provider}/callback?${params.toString()}`);
  }

  // --- Projects ---

  async listProjects(params?: { search?: string; status?: string }): Promise<Project[]> {
    const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null) as [string, string][]).toString() : '';
    return this.request<Project[]>('GET', `/projects${qs}`);
  }

  async getProject(id: string): Promise<Project> {
    return this.request<Project>('GET', `/projects/${id}`);
  }

  // --- Annotations ---

  async listAnnotations(projectId: string, params?: { status?: string }): Promise<Annotation[]> {
    const qs = params?.status ? `?status=${params.status}` : '';
    return this.request<Annotation[]>('GET', `/projects/${projectId}/annotations${qs}`);
  }

  async createAnnotation(projectId: string, data: CreateAnnotationInput): Promise<Annotation> {
    return this.request<Annotation>('POST', `/projects/${projectId}/annotations`, data);
  }

  async updateAnnotation(id: string, data: UpdateAnnotationInput): Promise<Annotation> {
    return this.request<Annotation>('PUT', `/annotations/${id}`, data);
  }

  async deleteAnnotation(id: string): Promise<void> {
    await this.request<void>('DELETE', `/annotations/${id}`);
  }

  async changeStatus(id: string, status: string): Promise<Annotation> {
    return this.request<Annotation>('PUT', `/annotations/${id}/status`, { status });
  }

  // --- Comments ---

  async listComments(annotationId: string): Promise<Comment[]> {
    return this.request<Comment[]>('GET', `/annotations/${annotationId}/comments`);
  }

  async createComment(annotationId: string, body: string): Promise<Comment> {
    return this.request<Comment>('POST', `/annotations/${annotationId}/comments`, { body });
  }

  // --- Screenshots ---

  async uploadScreenshot(annotationId: string, imageData: Blob | ArrayBuffer): Promise<{ url: string }> {
    const url = `${this.config.baseUrl}/api/v1/annotations/${annotationId}/screenshot`;
    const headers: Record<string, string> = { ...this.authHeaders(), 'Content-Type': 'application/octet-stream' };
    const res = await fetch(url, { method: 'POST', headers, body: imageData });
    if (!res.ok) await this.handleError(res);
    return res.json() as Promise<{ url: string }>;
  }

  // --- Notifications ---

  async listNotifications(params?: { limit?: number; offset?: number }): Promise<{ notifications: Notification[]; unreadCount: number }> {
    const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString() : '';
    return this.request<{ notifications: Notification[]; unreadCount: number }>('GET', `/notifications${qs}`);
  }

  async markRead(notificationId: string): Promise<void> {
    await this.request<void>('PUT', `/notifications/${notificationId}/read`);
  }

  async markAllRead(): Promise<void> {
    await this.request<void>('PUT', '/notifications/read-all');
  }

  // --- Real-time ---

  connect(): void {
    const wsUrl = this.config.baseUrl.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
    this.ws = new WebSocket(wsUrl);
    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data));
        if (data.event && this.listeners.has(data.event)) {
          this.listeners.get(data.event)!.forEach(cb => cb(data.payload));
        }
      } catch { /* ignore non-JSON frames */ }
    };
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  onAnnotationCreated(cb: (annotation: Annotation) => void): () => void {
    return this.on('annotation:created', cb as (data: unknown) => void);
  }

  onNotification(cb: (notification: Notification) => void): () => void {
    return this.on('notification', cb as (data: unknown) => void);
  }

  // --- Private ---

  private on(event: string, cb: (data: unknown) => void): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
    return () => { this.listeners.get(event)?.delete(cb); };
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.token) headers['Authorization'] = `Bearer ${this.config.token}`;
    if (this.config.apiKey) headers['X-API-Key'] = this.config.apiKey;
    return headers;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.config.baseUrl}/api/v1${path}`;
    const headers: Record<string, string> = { ...this.authHeaders() };
    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    if (!res.ok) await this.handleError(res);
    if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
    return res.json() as Promise<T>;
  }

  private async handleError(res: Response): Promise<never> {
    if (res.status === 401) this.config.onAuthRequired?.();
    const text = await res.text().catch(() => '');
    throw new PinpointApiError(res.status, text);
  }
}

export class PinpointApiError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Pinpoint API error ${status}: ${body}`);
    this.name = 'PinpointApiError';
  }
}

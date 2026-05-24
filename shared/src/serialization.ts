// @pinpoint/shared — Annotation serialization utilities
import type { Annotation } from './types.js';
import { AnnotationSchema } from './schemas.js';

// --- Result type ---

export interface ValidationError {
  message: string;
}

export type Result<T, E> =
  | { success: true; data: T }
  | { success: false; error: E };

// --- Serialization ---

export function serializeAnnotation(annotation: Annotation): string {
  return JSON.stringify(annotation);
}

export function deserializeAnnotation(json: string): Result<Annotation, ValidationError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { success: false, error: { message: 'Invalid JSON: unable to parse input' } };
  }

  const result = AnnotationSchema.safeParse(parsed);

  if (result.success) {
    return { success: true, data: result.data as Annotation };
  }

  const message = result.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');

  return { success: false, error: { message } };
}

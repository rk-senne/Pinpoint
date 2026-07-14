import { z } from 'zod';

export const PaginationParamsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export type PaginationParams = z.infer<typeof PaginationParamsSchema>;

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export function paginationMeta(total: number, page: number, pageSize: number) {
  return {
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize),
  };
}

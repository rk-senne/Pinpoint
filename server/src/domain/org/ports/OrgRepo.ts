export interface Org {
  id: string;
  name: string;
  slug: string;
  plan: string;
  createdAt: string;
}

export interface OrgPatch {
  name?: string;
  slug?: string;
}

export interface OrgRepo {
  findById(id: string): Promise<Org | null>;
  update(id: string, patch: OrgPatch): Promise<Org>;
}

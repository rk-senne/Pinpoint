// Inbound HTTP adapter — ambient type augmentation.
//
// Hosts the `Express.Request.user` declaration for the hex inbound
// HTTP layer. The augmentation lives here so the hex adapters keep
// type-checking with a single ambient declaration shared by every
// route module.
//
// `AuthPayload` matches the shape `createAuthMiddleware` writes onto
// `req.user` after decoding a JWT (see `auth.middleware.ts`). Routes
// access it via `req.user!.userId` / `req.user!.email`.

export interface AuthPayload {
  userId: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

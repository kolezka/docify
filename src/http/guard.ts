// Framework-free request pipeline: a guard either lets a request through (null) or answers it.
// Guards may fill in the context for later ones, e.g. auth sets the client name.

export interface RequestContext {
  ip: string;
  client?: string;
}

export type Handler = (req: Request, ctx: RequestContext) => Response | Promise<Response>;
export type Guard = (req: Request, ctx: RequestContext) => Response | null | Promise<Response | null>;

export function chain(guards: Guard[], handler: Handler): Handler {
  return async (req, ctx) => {
    for (const guard of guards) {
      const blocked = await guard(req, ctx);
      if (blocked) return blocked;
    }
    return handler(req, ctx);
  };
}

export function jsonError(status: number, code: string, error: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error, code }, { status, headers });
}

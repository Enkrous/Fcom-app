/**
 * _shared/response.ts
 * Helpers for uniform API responses.
 * All responses follow: { ok: true, ... } or { ok: false, error: "text" }
 *
 * CORS origin:
 *   Set ALLOWED_ORIGIN env var to your production domain (e.g. "https://fcom.example.com").
 *   If not set, defaults to "*" — safe for local development, but tighten for production.
 */

function getAllowedOrigin(): string {
  return Deno.env.get('ALLOWED_ORIGIN') ?? '*';
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin':  getAllowedOrigin(),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

export function ok(data: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ ok: true, ...data }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    },
  );
}

export function err(error: string, status = 400): Response {
  return new Response(
    JSON.stringify({ ok: false, error }),
    {
      status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    },
  );
}

export function corsPrelight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

/** Preserve the JSON envelope even when a database/helper throws. */
export function withErrorHandling(
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (error) {
      console.error('unhandled Edge Function error:', error);
      return err('internal_error', 500);
    }
  };
}

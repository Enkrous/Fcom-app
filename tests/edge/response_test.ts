import { withErrorHandling } from '../../supabase/functions/_shared/response.ts';

Deno.test('uncaught helper errors return a stable JSON error without database details', async () => {
  const handler = withErrorHandling(async () => { throw new Error('private_database_detail'); });
  const response = await handler(new Request('http://localhost'));
  const body = await response.json();
  if (response.status !== 500 || body.ok !== false || body.error !== 'internal_error') {
    throw new Error('unexpected unhandled-error contract');
  }
});

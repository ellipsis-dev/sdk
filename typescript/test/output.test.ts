import { expect, expectTypeOf, it } from 'vitest';
import { Ellipsis } from '../src/core/client';

it.each([{}, { result: [false, null, { word: 'é' }] }])(
  'returns the customer structured output as JSON',
  async (payload) => {
    const client = new Ellipsis({
      apiKey: 'fixture',
      fetch: async () => new Response(JSON.stringify(payload), { status: 200 }),
    });
    const output = await client.sessions.output('session_1');
    expectTypeOf(output).toEqualTypeOf<Record<string, unknown>>();
    expect(output).toEqual(payload);
  }
);

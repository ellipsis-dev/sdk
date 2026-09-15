// Invoked by the backend Database suite against its real V1 router and worker.
// Build first with `pnpm build`; this exercises the shipped SDK transport.
import { Ellipsis } from '../dist/index.js';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { baseURL, apiKey, operation, sessionId, options } = JSON.parse(input);
const client = new Ellipsis({ apiKey, baseUrl: baseURL, maxRetries: 0 });
try {
  let response;
  switch (operation) {
    case 'start':
      response = await client.sessions.start(options);
      break;
    case 'get':
      response = await client.sessions.get(sessionId);
      break;
    case 'update':
      response = await client.sessions.update(sessionId, options);
      break;
    case 'file_create':
      response = await client.files.create(options);
      break;
    case 'file_get':
      response = await client.files.get(sessionId);
      break;
    case 'files':
      response = (await client.files.list({ session_id: sessionId })).response;
      break;
    case 'output':
      response = await client.sessions.output(sessionId);
      break;
    case 'diff':
      response = await client.sessions.diff(sessionId);
      break;
    case 'executions':
      response = await client.sessions.executions(sessionId);
      break;
    case 'send':
      response = await client.sessions.sendMessage(sessionId, options);
      break;
    case 'records': {
      const page = await client.sessions.records(sessionId, options);
      const records = [];
      for await (const record of page) records.push(record);
      response = { ...page.response, records };
      break;
    }
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
  process.stdout.write(JSON.stringify(response));
} catch (error) {
  if (!error.status) throw error;
  process.stdout.write(
    JSON.stringify({ error: { status: error.status, code: error.code } })
  );
}

# Ellipsis SDKs

The official SDKs for the [Ellipsis](https://www.ellipsis.dev) agents
platform — every `/v1` operation in both languages, generated from the same
committed OpenAPI spec.

| Language | Install | Source |
|---|---|---|
| Python | `pip install ellipsis-dev` (`import ellipsis`) | [`python/`](./python) |
| TypeScript | `npm install @ellipsis-dev/sdk` | [`typescript/`](./typescript) |

The contract documents both SDKs generate from are in
[`schema/`](./schema): the OpenAPI spec (`openapi.v1.json`), the WebSocket
stream frames (`frames.schema.json`), and the session lifecycle payloads
(`lifecycle.schema.json`).

```python
from ellipsis import Ellipsis

client = Ellipsis(api_key="...")
handle = client.sessions.run(prompt="Fix the flaky test in ci/")
print(handle.wait().status)
```

```typescript
import { Ellipsis } from '@ellipsis-dev/sdk';

const client = new Ellipsis({ apiKey: '...' });
const handle = await client.sessions.run({ prompt: 'Fix the flaky test' });
await handle.wait();
```

Docs: https://www.ellipsis.dev/docs/api

## About this repository

This is a **read-only mirror**: release snapshots are force-pushed from the
Ellipsis platform monorepo, which is the source of truth. Issues are
disabled and pull requests are not accepted — to report a problem, email
support@ellipsis.dev.

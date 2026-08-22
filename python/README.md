# ellipsis-dev — the Ellipsis Python SDK

Drive Ellipsis agent sessions from Python. Every `/v1` operation, sync and
async, generated from the platform's committed OpenAPI spec.

```python
from ellipsis import Ellipsis

client = Ellipsis(api_key="...")  # an API key from app.ellipsis.dev

session = client.sessions.start(prompt="Fix the flaky test in ci/").session
for s in client.sessions.list():  # cursor pagination walks every page
    print(s.id, s.status)
```

Async is the same surface:

```python
from ellipsis import AsyncEllipsis

async with AsyncEllipsis(api_key="...") as client:
    me = await client.me()
```

Docs: https://www.ellipsis.dev/docs/api

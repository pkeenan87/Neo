# scheduledTaskPoller

Timer-triggered Azure Function that wakes up every 2 minutes and POSTs to the
Neo web app's `/api/internal/scheduled-tasks/poll` endpoint. The endpoint does
the actual work (find due tasks, claim via etag, run the agent loop, route
output). This Function is a thin "wake up and call home" wrapper.

## Why a separate Function

Azure Functions Timer Triggers have static cron schedules baked into code, not
runtime config. Per-task schedules live in Cosmos DB (`scheduledTasks`
container). The poller pattern keeps the Function code static and lets the
Web App own the dynamic task configuration.

## Required Function App settings

| Setting | Value |
|---|---|
| `NEO_WEB_URL` | Base URL of the Neo web app (e.g. `https://neo.example.com`) |
| `NEO_WEB_AUDIENCE` | App-id-URI of the Neo web app's Entra app registration (e.g. `api://<web-app-client-id>`) |
| `FUNCTIONS_WORKER_RUNTIME` | `node` |
| `AzureWebJobsStorage` | Connection string or identity-based config for the AzureWebJobs storage |

The Function must also have **system-assigned Managed Identity enabled**. Its
object id (`principalId`) is what authenticates against the Web App's internal
endpoint.

## Required Web App settings (mirror)

The Web App must know which MI is allowed to call the internal endpoint:

| Setting | Value |
|---|---|
| `SCHEDULED_TASK_POLLER_MI_OID` | The Function App MI's object id (`principalId`) |
| `SCHEDULED_TASK_POLLER_AUDIENCE` | Same value as `NEO_WEB_AUDIENCE` above |
| `AZURE_TENANT_ID` | Already configured for other AAD-protected endpoints |

## Local development

Copy `local.settings.json.example` to `local.settings.json` and fill in the
values. For local testing against a dev Web App, set
`SCHEDULED_TASK_POLLER_DEV_BYPASS=true` on the Web App so the internal endpoint
skips token verification.

```bash
cd functions/scheduledTaskPoller
npm install
npm start
```

The function will fire on a 2-minute cadence. `func start` also exposes a
manual-trigger endpoint at
`http://localhost:7071/admin/functions/scheduledTaskPoller` (POST any JSON
body) for ad-hoc invocation during development.

## Deploy

```bash
cd functions/scheduledTaskPoller
npm run build
func azure functionapp publish <function-app-name>
```

Then configure the Function App settings above via the Azure portal or
`az functionapp config appsettings set`.

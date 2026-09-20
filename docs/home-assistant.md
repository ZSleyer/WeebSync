# Home Assistant integration

WeebSync offers a token-protected REST status API that Home Assistant can poll
via `rest` sensors, plus a trigger endpoint to kick off watches manually.

## Generate a token

Settings → Security → **API token** → *Generate*. The token is shown only
once. Store it as a secret in Home Assistant (`secrets.yaml`):

```yaml
weebsync_token: "Bearer <token>"
```

The token permits exactly two endpoints:

- `GET /api/status` - aggregated status (downloads, watches, disk)
- `POST /api/watches/{id}/check` - check/sync a watch immediately

## Status endpoint

```
GET /api/status
Authorization: Bearer <token>
```

```json
{
  "downloads": {
    "active": 1,
    "queued": 2,
    "running": [
      { "id": 12, "name": "Ep01.mkv", "status": "running", "size": 1234, "transferred": 600, "bytesPerSec": 5000, "progress": 0.49 }
    ]
  },
  "lastFinished": [
    { "id": 11, "name": "Ep00.mkv", "status": "done", "finishedAt": "2026-07-16 10:00:00" }
  ],
  "watches": [
    { "id": 3, "name": "ShowX", "lastCheck": "2026-07-16 09:30:00", "lastResult": "3 new" }
  ],
  "attention": {
    "count": 1,
    "reasons": { "checkFailed": 1 },
    "watches": [ { "id": 3, "name": "ShowX", "reasons": ["checkFailed"] } ]
  },
  "nextReleases": [
    { "at": 1789000000, "name": "ShowX", "episode": 8, "dub": "de", "est": true }
  ],
  "jobs": { "running": ["match"], "paused": [] },
  "disk": { "path": "/downloads", "totalBytes": 0, "freeBytes": 0, "usedBytes": 0 }
}
```

`downloads` also carries `totalBytesPerSec` (sum over the running
transfers) and `etaSeconds` (remaining queue bytes at that rate, 0 while
nothing moves). `attention.reasons` counts per reason - `checkFailed`,
`behind`, `missing`, `dubOverdue`, `langWaiting`, `unsorted`,
`plexStreamMiss` - the same list the dashboard's "Needs attention"
section reads. `nextReleases` are the next five upcoming episode slots
across all watches; `dub` names a dub slot's language and `est` marks a
projected date.

## Sensors (configuration.yaml)

```yaml
rest:
  - resource: https://weebsync.example.com/api/status
    headers:
      Authorization: !secret weebsync_token
    scan_interval: 60
    sensor:
      - name: WeebSync active downloads
        value_template: "{{ value_json.downloads.active }}"
      - name: WeebSync queued downloads
        value_template: "{{ value_json.downloads.queued }}"
      - name: WeebSync last finished
        value_template: >-
          {{ (value_json.lastFinished | first).name if value_json.lastFinished else 'none' }}
        json_attributes_path: "$.lastFinished[0]"
        json_attributes: [status, finishedAt]
      - name: WeebSync disk free
        value_template: "{{ (value_json.disk.freeBytes / 1073741824) | round(1) }}"
        unit_of_measurement: GB
      - name: WeebSync needs attention
        value_template: "{{ value_json.attention.count }}"
        json_attributes_path: "$.attention"
        json_attributes: [reasons, watches]
      - name: WeebSync next release
        value_template: >-
          {{ (value_json.nextReleases | first).name if value_json.nextReleases else 'none' }}
        json_attributes_path: "$.nextReleases[0]"
        json_attributes: [at, episode, dub, est]
      - name: WeebSync download speed
        value_template: "{{ (value_json.downloads.totalBytesPerSec / 1048576) | round(1) }}"
        unit_of_measurement: MB/s
      - name: WeebSync queue ETA
        value_template: "{{ (value_json.downloads.etaSeconds / 60) | round(0) }}"
        unit_of_measurement: min
```

## Triggering a watch from Home Assistant

```yaml
rest_command:
  weebsync_check_watch:
    url: "https://weebsync.example.com/api/watches/{{ watch_id }}/check"
    method: POST
    headers:
      Authorization: !secret weebsync_token
```

Invoked e.g. from an automation:

```yaml
action:
  - service: rest_command.weebsync_check_watch
    data:
      watch_id: 3
```

The watch IDs are listed in the `watches` array of the status response.

## Events (webhook push)

WeebSync can push events to a Home Assistant webhook the moment they
happen. Enter the webhook URL under Settings → Integrations →
**Home Assistant**, e.g.

```
http://homeassistant.local:8123/api/webhook/weebsync
```

The webhook id in the path acts as the secret (Home Assistant's own
model); pick a long random one. WeebSync POSTs JSON:

- `download_finished` / `download_error` - as a transfer ends:
  `{"event", "name", "error", "errorCode", "at"}`
- `attention_changed` - when the needs-attention picture changes
  (checked once a minute): `{"event", "count", "reasons", "watches", "at"}`

An automation reacts through a webhook trigger; the payload is
`trigger.json`:

```yaml
automation:
  - alias: WeebSync events
    trigger:
      - platform: webhook
        webhook_id: weebsync
        allowed_methods: [POST]
        local_only: true
    action:
      - service: notify.mobile_app
        data:
          message: >-
            WeebSync {{ trigger.json.event }}:
            {{ trigger.json.name | default(trigger.json.count) }}
            {{ trigger.json.error | default('') }}
```

Delivery is fire-and-forget with one retry - the sensors above remain
the source of truth, the webhook only removes the polling delay. Without
a configured URL nothing is posted.

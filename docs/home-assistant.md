# Home-Assistant-Integration

WeebSync bietet eine tokengeschützte REST-Status-API, die Home Assistant per
`rest`-Sensor pollen kann, plus einen Trigger-Endpoint zum manuellen Anstoßen
von Watches.

## Token erzeugen

Einstellungen → Sicherheit → **API-Token** → *Generieren*. Der Token wird nur
einmal angezeigt. In Home Assistant als Secret ablegen (`secrets.yaml`):

```yaml
weebsync_token: "Bearer <token>"
```

Der Token erlaubt genau zwei Endpoints:

- `GET /api/status` — aggregierter Status (Downloads, Watches, Disk)
- `POST /api/watches/{id}/check` — Watch sofort prüfen/syncen

## Status-Endpoint

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
    { "id": 3, "name": "ShowX", "lastCheck": "2026-07-16 09:30:00", "lastResult": "3 neu" }
  ],
  "disk": { "path": "/downloads", "totalBytes": 0, "freeBytes": 0, "usedBytes": 0 }
}
```

## Sensoren (configuration.yaml)

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
```

## Watch aus Home Assistant triggern

```yaml
rest_command:
  weebsync_check_watch:
    url: "https://weebsync.example.com/api/watches/{{ watch_id }}/check"
    method: POST
    headers:
      Authorization: !secret weebsync_token
```

Aufruf z. B. in einer Automation:

```yaml
action:
  - service: rest_command.weebsync_check_watch
    data:
      watch_id: 3
```

Die Watch-IDs stehen im `watches`-Array der Status-Antwort.

## Events (Download fertig/fehlgeschlagen)

Es gibt keinen Webhook — Events entstehen durch Polling: der Sensor
`WeebSync last finished` wechselt seinen Zustand, sobald ein Download
abgeschlossen ist. Darauf lässt sich eine Automation bauen:

```yaml
automation:
  - alias: WeebSync download finished
    trigger:
      - platform: state
        entity_id: sensor.weebsync_last_finished
    condition:
      - condition: template
        value_template: "{{ trigger.to_state.state not in ['none', 'unknown', 'unavailable'] }}"
    action:
      - service: notify.mobile_app
        data:
          message: >-
            WeebSync: {{ trigger.to_state.state }}
            ({{ state_attr('sensor.weebsync_last_finished', 'status') }})
```

Bei `scan_interval: 60` kommen Events mit bis zu einer Minute Verzögerung.

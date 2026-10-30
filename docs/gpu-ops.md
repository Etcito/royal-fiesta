# GPU ops

The GPU client accepts only op names in `apps/web/public/nmc.gpu.json`:
`{"page":"game.html","ops":["controlsProbe","gameCapture","roundCapture","frameTiming","zoneCapture","zoneLobbyCapture"]}`.
game.html registers these ops on every load. The input schemas, examples and output shapes the
declaration used to hold live here, unchanged.

`hubLoopCapture` is not declared: it lives on play.html (`play.html?mode=ops`), which is not the declared
page. The ops on `client.html?mode=ops` (roundCapture, frameTiming) stay for manual use.

Ops are exposed as `window.nmcGpu.ops.<name>(input)`.

## controlsProbe

Page for manual runs: `game.html?mode=ops`.

1 client at 1280x720 on the player page: each case resets the character to spawn 0 facing +Z with the orbit camera behind, drives one input (real KeyboardEvents on window, a synthetic standard gamepad through navigator.getGamepads, pointer-lock movementX mousemoves) for holdMs, and records the projected screen x before and after (character cases: the local character; view cases: a world marker placed at screen centre) with a PNG capture each; refuses when RAA is unavailable

### Input schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "width",
    "height",
    "content",
    "course",
    "cases"
  ],
  "properties": {
    "width": {
      "const": 1280
    },
    "height": {
      "const": 720
    },
    "content": {
      "enum": [
        "v0",
        "v1",
        "sdf"
      ]
    },
    "course": {
      "type": "string",
      "pattern": "^[a-z0-9-]{1,40}$",
      "description": "race or survival course id of the content (spawn 0 is used)"
    },
    "cases": {
      "type": "array",
      "minItems": 1,
      "maxItems": 16,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "name",
          "input",
          "holdMs"
        ],
        "properties": {
          "name": {
            "type": "string",
            "pattern": "^[a-z0-9-]{1,40}$",
            "description": "unique per case"
          },
          "input": {
            "enum": [
              "KeyD",
              "ArrowRight",
              "stickRight",
              "KeyA",
              "ArrowLeft",
              "stickLeft",
              "mouseRight",
              "rightStickRight"
            ]
          },
          "holdMs": {
            "type": "integer",
            "minimum": 1,
            "maximum": 5000
          }
        }
      }
    }
  }
}
```

### Example

```json
{
  "width": 1280,
  "height": 720,
  "content": "v0",
  "course": "race-sprint",
  "cases": [
    {
      "name": "key-d",
      "input": "KeyD",
      "holdMs": 500
    },
    {
      "name": "arrow-right",
      "input": "ArrowRight",
      "holdMs": 500
    },
    {
      "name": "stick-right",
      "input": "stickRight",
      "holdMs": 500
    },
    {
      "name": "key-a",
      "input": "KeyA",
      "holdMs": 500
    },
    {
      "name": "arrow-left",
      "input": "ArrowLeft",
      "holdMs": 500
    },
    {
      "name": "stick-left",
      "input": "stickLeft",
      "holdMs": 500
    },
    {
      "name": "mouse-right",
      "input": "mouseRight",
      "holdMs": 500
    },
    {
      "name": "right-stick-right",
      "input": "rightStickRight",
      "holdMs": 500
    }
  ]
}
```

### Output

{ json: { renderer: 'raa', adapter: { vendor, architecture, description, software }, software, pageRef, content, course, cases: [{ name, input, subject: 'character' | 'view', device: 'keyboard' | 'synthetic-pad' | 'pointer-lock-events', beforeX, afterX, centreX, captures: [{ name, sha256, bytes, nonEmpty }] }] }, files: [<case>-before.png, <case>-after.png] } (S17 proofs/m15/controls.json)

## gameCapture

Page for manual runs: `game.html?mode=ops`.

Player flow on game.html (in-page with bots, 2 or 4 piloted clients over a LoopbackRelay tiled per planCanvases, or one relay client with net) with PNG captures at named moments; with reload it loads the content twice in the same page (cache layers persist); refuses when RAA is unavailable

### Input schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "content",
    "flow",
    "clients",
    "width",
    "height",
    "captureAt"
  ],
  "properties": {
    "content": {
      "enum": [
        "v0",
        "v1",
        "sdf"
      ]
    },
    "course": {
      "type": "string",
      "pattern": "^[a-z0-9-]{1,40}$",
      "description": "plays that race or survival course as one sprint round with bots; clients 1, no net"
    },
    "flow": {
      "enum": [
        "match",
        "hub",
        "podium",
        "tour"
      ]
    },
    "clients": {
      "enum": [
        1,
        2,
        4
      ]
    },
    "width": {
      "type": "integer",
      "minimum": 64,
      "maximum": 3840
    },
    "height": {
      "type": "integer",
      "minimum": 64,
      "maximum": 2160
    },
    "captureAt": {
      "type": "array",
      "minItems": 1,
      "maxItems": 16,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "pattern": "^(loading|hub|podium|back-in-hub|match-[0-9]+(\\.[0-9]+)?s)$"
      },
      "description": "Moments of the flow in flow order, match seconds ascending (<= 600): hub = loading, hub; match = loading, match-<s>s, podium; podium = loading, podium; tour = loading, hub, match-<s>s, podium, back-in-hub"
    },
    "reload": {
      "type": "boolean"
    },
    "net": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "server",
        "party"
      ],
      "properties": {
        "server": {
          "type": "string",
          "pattern": "^wss?://\\S+$",
          "description": "relay URL passed at run time, redacted in records"
        },
        "party": {
          "const": 2
        }
      }
    }
  }
}
```

### Example

```json
{
  "content": "v1",
  "flow": "tour",
  "clients": 1,
  "width": 1920,
  "height": 1080,
  "captureAt": [
    "loading",
    "hub",
    "match-12s",
    "podium",
    "back-in-hub"
  ],
  "reload": true
}
```

### Output

{ json: { renderer: 'raa', adapter: { vendor, architecture, description, software }, software, pageRef, captures: [{ name, width, height, sha256, bytes, nonEmpty }], frameTiming: null, content, courses, events: [{ t, what }], report, reports }, files: [<moment>.png, and reload-<moment>.png with reload] } (S10 captures plus S17 events and content.report())

## roundCapture

Page for manual runs: `client.html?mode=ops`.

4-client in-page sprint round on one RAA port (2x2 grid of 960x540), PNG captures with the HUD drawn on

### Input schema

```json
{
  "type": "object",
  "required": [
    "clients",
    "profile",
    "width",
    "height",
    "captureAtS"
  ],
  "properties": {
    "clients": {
      "const": 4
    },
    "profile": {
      "const": "sprint"
    },
    "width": {
      "const": 1920
    },
    "height": {
      "const": 1080
    },
    "captureAtS": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "number",
        "minimum": 0,
        "maximum": 600
      },
      "description": "sim seconds, strictly ascending"
    }
  }
}
```

### Example

```json
{
  "clients": 4,
  "profile": "sprint",
  "width": 1920,
  "height": 1080,
  "captureAtS": [
    3,
    12,
    40
  ]
}
```

### Output

{ captures: [{ name: 'round-<t>s', width, height, mime: 'image/png', base64 }], adapter: { vendor, architecture, description, software }, renderer: 'raa' }

## frameTiming

Page for manual runs: `client.html?mode=ops`.

1 client rendering race-bean-dash (40 obstacles, 8 characters) at 1920x1080: port.render frameMs over requestAnimationFrame frames after 60 warm-up frames

### Input schema

```json
{
  "type": "object",
  "required": [
    "frames",
    "width",
    "height"
  ],
  "properties": {
    "frames": {
      "type": "integer",
      "minimum": 1,
      "maximum": 10000
    },
    "width": {
      "const": 1920
    },
    "height": {
      "const": 1080
    }
  }
}
```

### Example

```json
{
  "frames": 600,
  "width": 1920,
  "height": 1080
}
```

### Output

{ p50Ms, p95Ms (nearest rank), frames, adapter: { vendor, architecture, description, software } }

## hubLoopCapture

Page for manual runs: `play.html?mode=ops`.

4-client piloted hub -> sprint match -> podium -> hub loop on one RAA port, in a 2x2 grid of 960x540 viewports, with PNG captures and flow events

### Input schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "clients",
    "width",
    "height",
    "captureAt"
  ],
  "properties": {
    "clients": {
      "const": 4
    },
    "width": {
      "const": 1920
    },
    "height": {
      "const": 1080
    },
    "captureAt": {
      "type": "array",
      "minItems": 1,
      "maxItems": 4,
      "uniqueItems": true,
      "items": {
        "enum": [
          "hub",
          "match",
          "podium",
          "back-in-hub"
        ]
      },
      "description": "Strictly ordered subset: hub (120 frames with 3 remotes each), match (600 frames after all enter), podium (60 frames after all enter), back-in-hub (120 frames after done)"
    }
  }
}
```

### Example

```json
{
  "clients": 4,
  "width": 1920,
  "height": 1080,
  "captureAt": [
    "hub",
    "match",
    "podium",
    "back-in-hub"
  ]
}
```

### Output

{ captures: [{ name: 'hub-loop-<name>', width: 1920, height: 1080, mime: 'image/png', base64 }], adapter: { vendor, architecture, description, software }, renderer: 'raa', events }

## zoneCapture

Page for manual runs: `game.html?mode=ops`.

One zoned match on game.html (`peers` machines x `seatsPerPeer` local seats) with the seats spread along the course path, stepped `seconds` at a virtual 1/60 s clock and captured once as one 1280x720 RAA PNG. `near` and `far` are the player counts drawn: the local peer's domain characters through SceneView and the local FarFeed seats through FarRenderer. Refuses when RAA is unavailable and never captures with the null port.

### Input schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "width",
    "height",
    "peers",
    "seatsPerPeer",
    "course",
    "seconds"
  ],
  "properties": {
    "width": {
      "const": 1280
    },
    "height": {
      "const": 720
    },
    "peers": {
      "type": "integer",
      "minimum": 2,
      "maximum": 8
    },
    "seatsPerPeer": {
      "type": "integer",
      "minimum": 1,
      "maximum": 2
    },
    "course": {
      "type": "string",
      "pattern": "^[a-z0-9-]{1,40}$",
      "description": "match course id with a courses/<courseId>.zones.json sidecar"
    },
    "seconds": {
      "type": "number",
      "minimum": 0,
      "maximum": 120,
      "description": "sim seconds stepped before the capture (at least one 1/60 s frame)"
    }
  }
}
```

### Example

```json
{
  "width": 1280,
  "height": 720,
  "peers": 4,
  "seatsPerPeer": 2,
  "course": "race-sprint",
  "seconds": 30
}
```

### Output

{ json: { renderer: 'raa', adapter: { vendor, architecture, description, software }, near, far, captures: [{ name: 'zone-view', width: 1280, height: 720, mime: 'image/png', base64 }] }, files: [] }

## zoneLobbyCapture

Page for manual runs: `game.html?mode=ops`.

One browser peer joins a real relay zone room (`players` machines x `seatsPerPeer` local seats, every local seat on a takeover bot) and plays `seconds` on the real clock, then captures once as one 1280x720 RAA PNG. `matched` is the room (`peers`, `seats`, `localPeer`), `ticks` the final match tick, and `near`/`far` the drawn player counts: the local peer's domain characters through SceneView and the local FarFeed seats through FarRenderer. The relay URL is never echoed. Refuses when RAA is unavailable and never captures with the null port.

### Input schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "relay",
    "players",
    "seatsPerPeer",
    "course",
    "seconds",
    "name",
    "width",
    "height"
  ],
  "properties": {
    "relay": {
      "type": "string",
      "pattern": "^wss?://\\S+$",
      "description": "zone relay URL, never echoed in the output"
    },
    "players": {
      "type": "integer",
      "minimum": 2,
      "maximum": 64
    },
    "seatsPerPeer": {
      "type": "integer",
      "minimum": 1,
      "maximum": 4
    },
    "course": {
      "type": "string",
      "pattern": "^[a-z0-9-]{1,40}$",
      "description": "match course id with a courses/<courseId>.zones.json sidecar"
    },
    "seconds": {
      "type": "number",
      "minimum": 1,
      "maximum": 120,
      "description": "real seconds played before the capture"
    },
    "name": {
      "type": "string",
      "pattern": "^[a-z0-9-]{1,32}$"
    },
    "width": {
      "const": 1280
    },
    "height": {
      "const": 720
    }
  }
}
```

### Example

```json
{
  "relay": "ws://127.0.0.1:8787",
  "players": 4,
  "seatsPerPeer": 2,
  "course": "race-sprint",
  "seconds": 20,
  "name": "zone-lobby",
  "width": 1280,
  "height": 720
}
```

### Output

{ json: { renderer: 'raa', adapter: { vendor, architecture, description, software }, matched: { peers, seats, localPeer }, ticks, near, far, captures: [{ name: 'zone-lobby', width: 1280, height: 720, mime: 'image/png', base64 }] }, files: [] }

# TCP Flow Health Monitor - Message Schema

**Trigger version:** 3.2.0
**Transport:** Open Data Stream (ODS) - Kafka or HTTP
**Encoding:** JSON (one message per event)

---

## Overview

This trigger emits per-flow TCP health telemetry from ExtraHop. It is designed
for monitoring durable peer-to-peer TCP connections (e.g. ISO 8583) where both
endpoints use static ports and the socket tuple is long-lived.

Three distinct message types are emitted over the lifetime of a flow:

| msg_type     | ExtraHop event | Fires                             | Purpose                                  |
|--------------|----------------|-----------------------------------|------------------------------------------|
| `flow_open`  | TCP_OPEN       | Once per flow                     | Birth certificate - identity + handshake |
| `flow_tick`  | FLOW_TICK      | Per turn or per 128 payload bytes | Periodic TCP health snapshot             |
| `flow_close` | TCP_CLOSE      | Once per flow                     | Death certificate - termination status   |

All messages share a common envelope (version, msg_type, ts, flow_id) and a
consistent positional naming convention described below.

---

## Positional convention (_1 / _2)

All per-endpoint fields use a `_1` / `_2` suffix. These positions are assigned
by the ExtraHop platform when the flow is created and **remain consistent for
the entire lifetime of the flow**. They do not inherently imply client, server,
source, or destination - they are arbitrary but stable identifiers.

The `flow_open` message establishes what each position represents by providing
`ip_1`, `port_1`, `ip_2`, `port_2`. Downstream consumers should use these
fields to build a lookup (e.g. "position 1 = 10.1.2.3:8583, position 2 =
10.4.5.6:8583") and apply business labels as needed.

When the TCP 3-way handshake is observed, the `sender_is_1` field indicates
which position corresponds to the connection initiator (the SYN sender). That
value is stored in `Flow.store.identity` and echoed in every subsequent
`flow_tick` and `flow_close` message for the same `flow_id`. For loose
initiations, `sender_is_1` is null.

Every subsequent `flow_tick` and `flow_close` message for the same `flow_id`
uses the same positional assignment. Counters ending in `_1` always refer to
the same endpoint as `ip_1` from the open message.

---

## Common envelope

Present in **every** message type.

| Field      | Type    | Description                                                        |
|------------|---------|--------------------------------------------------------------------|
| `version`  | string  | Trigger version (e.g. `"3.2.0"`). Use for schema compatibility.   |
| `msg_type` | string  | One of `"flow_open"`, `"flow_tick"`, `"flow_close"`.               |
| `ts`       | integer | Message emission time. Epoch milliseconds from `Date.now()`.       |
| `flow_id`  | string  | ExtraHop-assigned unique flow identifier. Stable across all events for a given TCP connection. Join key. |

---

## flow_open

Emitted **once** when a TCP connection is initiated. This fires for all flows,
including "loose initiations" where the 3-way handshake was not observed
(e.g. the flow was already in progress when ExtraHop began monitoring).

When the handshake is observed, the message includes negotiated TCP parameters
and authoritative sender identification. For loose initiations, handshake-
dependent values are null.

### Identity

| Field    | Type         | Description                                                   |
|----------|--------------|---------------------------------------------------------------|
| `ip_1`   | string\|null | IPv4 or IPv6 address of endpoint 1. String representation.    |
| `port_1` | integer      | TCP port of endpoint 1.                                       |
| `mac_1`  | string\|null | MAC address of endpoint 1 (colon-separated). Null if the device is not discovered or is a gateway. |
| `ip_2`   | string\|null | IPv4 or IPv6 address of endpoint 2.                           |
| `port_2` | integer      | TCP port of endpoint 2.                                       |
| `mac_2`  | string\|null | MAC address of endpoint 2.                                    |

### Sender identification

| Field         | Type          | Description                                                |
|---------------|---------------|------------------------------------------------------------|
| `sender_is_1` | boolean\|null | Indicates which endpoint initiated the TCP connection (sent the SYN). `true` = endpoint 1 is the sender. `false` = endpoint 2 is the sender. `null` = loose initiation, sender is unknown. When null, the handshake was not observed and the platform cannot authoritatively determine which side initiated. |

### Network context

| Field        | Type         | Description                                                  |
|--------------|--------------|--------------------------------------------------------------|
| `ip_proto`   | string\|null | IP protocol name (e.g. `"TCP"`).                             |
| `ip_version` | string\|null | IP version (e.g. `"IPv4"`, `"IPv6"`).                        |
| `vlan`       | integer      | 802.1Q VLAN ID. `0` if untagged or unavailable.              |

### TCP handshake parameters

These fields are null on loose initiations (when `sender_is_1` is null).

| Field            | Type          | Description                                                 |
|------------------|---------------|-------------------------------------------------------------|
| `handshake_ms`   | number\|null  | Time to complete the 3-way handshake, in milliseconds.      |
| `window_scale_1` | integer\|null | TCP window scale factor negotiated by endpoint 1 (from TCP option kind 3). Null if not present in SYN/SYN-ACK. |
| `window_scale_2` | integer\|null | TCP window scale factor negotiated by endpoint 2.           |
| `init_rcv_wnd_1` | integer\|null | Initial TCP receive window size advertised by endpoint 1 during the handshake, in bytes. |
| `init_rcv_wnd_2` | integer\|null | Initial TCP receive window size advertised by endpoint 2.   |

### Fingerprints

These fields are null on loose initiations.

| Field    | Type         | Description                                               |
|----------|--------------|-----------------------------------------------------------|
| `ja4t_1` | string\|null | JA4T fingerprint for endpoint 1 (from the SYN). Encodes window size, TCP options, MSS, and window scale. |
| `ja4t_2` | string\|null | JA4TS fingerprint for endpoint 2 (from the SYN-ACK).     |

---

## flow_tick

Emitted on each **flow turn** (a complete request-response exchange) or after
**128 bytes of payload** in one direction, whichever comes first. For ISO 8583
traffic with short messages, ticks typically fire on turns. Tick intervals are
**not** fixed-period - they are transaction-driven and variable in duration.

### Value semantics

Most values are **deltas since the last tick** - they represent activity in
this interval only. The exceptions are noted below.

| Treatment          | Applies to                                                    |
|--------------------|---------------------------------------------------------------|
| **Delta**          | retrans_bytes, rto, zero_wnd, rcv_wnd_throttle, nagle_delay, l4_bytes, pkts, frag_pkts, overlap_segments, l2_bytes_1, l2_bytes_2 |
| **Per-interval**   | rtt_ms (median for this interval, not a delta or cumulative)  |
| **Last-observed**  | dscp_1, dscp_2 (most recent value, not a count)               |
| **Point-in-time**  | flow_age (current age of the flow at the time of this tick)   |

### Identity echo

| Field         | Type          | Description                                          |
|---------------|---------------|------------------------------------------------------|
| `ip_1`        | string\|null  | Same as flow_open. Echoed for standalone processing. |
| `port_1`      | integer       | Same as flow_open.                                   |
| `ip_2`        | string\|null  | Same as flow_open.                                   |
| `port_2`      | integer       | Same as flow_open.                                   |
| `sender_is_1` | boolean\|null | Echo of the sender identity established at flow_open. `true` = endpoint 1 initiated the connection, `false` = endpoint 2 initiated, `null` = sender unknown due to loose initiation. |

### Flow timing

| Field      | Type   | Description                                            |
|------------|--------|--------------------------------------------------------|
| `flow_age` | number | Time elapsed since the flow was initiated, in seconds. |

### Latency

| Field    | Type         | Description                                             |
|----------|--------------|---------------------------------------------------------|
| `rtt_ms` | number\|null | Median TCP round-trip time observed since the last tick, in milliseconds. Computed from ACK timing. `null` when no RTT samples exist in the interval (e.g. idle flow). |

### Retransmission

| Field             | Type    | Description                                          |
|-------------------|---------|------------------------------------------------------|
| `retrans_bytes_1` | integer | Bytes retransmitted by endpoint 1 since last tick.   |
| `retrans_bytes_2` | integer | Bytes retransmitted by endpoint 2 since last tick.   |
| `rto_1`           | integer | Retransmission timeout events for endpoint 1 since last tick. An RTO indicates the sender's retransmit timer expired without receiving an ACK. |
| `rto_2`           | integer | Retransmission timeout events for endpoint 2 since last tick. |

### Window health

| Field                | Type    | Description                                     |
|----------------------|---------|-------------------------------------------------|
| `zero_wnd_1`         | integer | Zero-window advertisements sent by endpoint 1 since last tick. Indicates the receiver's buffer is full. |
| `zero_wnd_2`         | integer | Zero-window advertisements from endpoint 2 since last tick. |
| `rcv_wnd_throttle_1` | integer | Receive-window throttle events for endpoint 1 since last tick. Indicates the receive window shrank enough to throttle the sender. |
| `rcv_wnd_throttle_2` | integer | Receive-window throttles for endpoint 2 since last tick. |

### Nagle

| Field           | Type    | Description                                       |
|-----------------|---------|---------------------------------------------------|
| `nagle_delay_1` | integer | Nagle-algorithm-induced delays for endpoint 1 since last tick. |
| `nagle_delay_2` | integer | Nagle delays for endpoint 2 since last tick.      |

### Throughput

| Field        | Type    | Treatment      | Description                                         |
|--------------|---------|----------------|-----------------------------------------------------|
| `l4_bytes_1` | integer | **Delta**      | L4 payload bytes from endpoint 1 since last tick.   |
| `l4_bytes_2` | integer | **Delta**      | L4 payload bytes from endpoint 2 since last tick.   |
| `pkts_1`     | integer | **Delta**      | Packets from endpoint 1 since last tick.            |
| `pkts_2`     | integer | **Delta**      | Packets from endpoint 2 since last tick.            |
| `l2_bytes_1` | integer | **Delta**      | L2 bytes (including Ethernet headers) from endpoint 1 since flow start. |
| `l2_bytes_2` | integer | **Delta**      | L2 bytes from endpoint 2 since flow start.          |

### DSCP

| Field    | Type    | Description                                             |
|----------|---------|--------------------------------------------------------|
| `dscp_1` | integer | Most recent DSCP numeric value in packets from endpoint 1. Not a count - this is the last value seen. See the DSCP reference table in the warehouse guidance section. |
| `dscp_2` | integer | Most recent DSCP value from endpoint 2.                 |

### IP fragmentation and TCP overlap

| Field                | Type    | Description                                     |
|----------------------|---------|-------------------------------------------------|
| `frag_pkts_1`        | integer | IP-fragmented packets from endpoint 1 since last tick. |
| `frag_pkts_2`        | integer | Fragmented packets from endpoint 2 since last tick. |
| `overlap_segments_1` | integer | Non-identical overlapping TCP segments from endpoint 1 since last tick. Two or more segments contained data for the same byte range. |
| `overlap_segments_2` | integer | Overlapping segments from endpoint 2 since last tick. |

---

## flow_close

Emitted **once** when the TCP connection terminates. Provides definitive
per-endpoint termination status. No inference required - these booleans reflect
the observed TCP state machine.

### Terminology

| Term        | Meaning                                                           |
|-------------|-------------------------------------------------------------------|
| **shutdown** | This endpoint sent a TCP FIN, initiating a graceful close.       |
| **reset**    | This endpoint sent a TCP RST after the flow was established.     |
| **aborted**  | This endpoint sent a TCP RST before the flow was fully established. |
| **expired**  | The flow timed out without any proper TCP termination.           |

### Identity echo

| Field         | Type          | Description                  |
|---------------|---------------|------------------------------|
| `ip_1`        | string\|null  | Same as flow_open.           |
| `port_1`      | integer       | Same as flow_open.           |
| `ip_2`        | string\|null  | Same as flow_open.           |
| `port_2`      | integer       | Same as flow_open.           |
| `sender_is_1` | boolean\|null | Echo of the sender identity established at flow_open. `true` = endpoint 1 initiated the connection, `false` = endpoint 2 initiated, `null` = sender unknown due to loose initiation. |

### Flow timing

| Field      | Type   | Description                                                        |
|------------|--------|--------------------------------------------------------------------|
| `flow_age` | number | Total duration of the flow from initiation to close, in seconds.   |

### Termination status

| Field        | Type    | Description                                                          |
|--------------|---------|----------------------------------------------------------------------|
| `shutdown_1` | boolean | `true` if endpoint 1 sent a TCP FIN (graceful close).                |
| `shutdown_2` | boolean | `true` if endpoint 2 sent a TCP FIN.                                 |
| `reset_1`    | boolean | `true` if endpoint 1 sent a TCP RST after the connection was established. |
| `reset_2`    | boolean | `true` if endpoint 2 sent a TCP RST after establishment.            |
| `aborted_1`  | boolean | `true` if endpoint 1 sent a TCP RST before the connection was fully established. |
| `aborted_2`  | boolean | `true` if endpoint 2 sent a TCP RST before establishment.           |
| `expired`    | boolean | `true` if the flow timed out without any proper TCP termination (no FIN, no RST). |

### Interpreting termination

| shutdown | reset | aborted | expired | Meaning                                          |
|----------|-------|---------|---------|--------------------------------------------------|
| 1: T, 2: T | 1: F, 2: F | 1: F, 2: F | F | Normal graceful close (both sides sent FIN)      |
| 1: T, 2: F | 1: F, 2: F | 1: F, 2: F | F | Half-close: endpoint 1 sent FIN, endpoint 2 has not |
| 1: F, 2: F | 1: T, 2: F | 1: F, 2: F | F | Endpoint 1 reset the established connection      |
| 1: F, 2: F | 1: F, 2: T | 1: F, 2: F | F | Endpoint 2 reset the established connection      |
| 1: T, 2: F | 1: F, 2: T | 1: F, 2: F | F | Endpoint 1 sent FIN, endpoint 2 sent RST during shutdown |
| 1: F, 2: F | 1: F, 2: F | 1: T, 2: F | F | Endpoint 1 aborted before establishment          |
| 1: F, 2: F | 1: F, 2: F | 1: F, 2: F | T | Connection expired without termination           |

---

## Warehouse guidance

### Joining flow lifecycle

All three message types share `flow_id`. A complete flow record is:

```sql
SELECT
    o.flow_id,
    o.ip_1, o.port_1, o.ip_2, o.port_2,
    o.sender_is_1,
    o.handshake_ms,
    t.*,
    c.shutdown_1, c.shutdown_2,
    c.reset_1, c.reset_2,
    c.aborted_1, c.aborted_2,
    c.expired
FROM flow_open  o
JOIN flow_tick  t ON t.flow_id = o.flow_id
JOIN flow_close c ON c.flow_id = o.flow_id
```

### Using sender_is_1

Because `sender_is_1` is echoed on `flow_tick` and `flow_close`, downstream
consumers can orient a tick or close record without first joining to the open
record, though `flow_id` joins are still recommended for full lifecycle views.

To label endpoints as sender/receiver:

```sql
SELECT
    flow_id,
    CASE WHEN sender_is_1 = true THEN ip_1 ELSE ip_2 END AS sender_ip,
    CASE WHEN sender_is_1 = true THEN ip_2 ELSE ip_1 END AS receiver_ip,
    CASE WHEN sender_is_1 = true THEN retrans_bytes_1 ELSE retrans_bytes_2 END AS sender_retrans,
    CASE WHEN sender_is_1 = true THEN retrans_bytes_2 ELSE retrans_bytes_1 END AS receiver_retrans
FROM flow_tick
WHERE sender_is_1 IS NOT NULL
```

Flows where `sender_is_1` is null (loose initiations) cannot be authoritatively
oriented. Query them using `_1`/`_2` directly, or filter them out if sender
attribution is required.

### Computing rates

Since most tick values are deltas, rates are computed directly:

```text
interval_sec = (tick[N].ts - tick[N-1].ts) / 1000
pps  = tick[N].pkts_1 / interval_sec
mbps = (tick[N].l4_bytes_1 * 8) / (interval_sec * 1_000_000)
```

### DSCP name resolution

The trigger emits numeric DSCP values. Standard mappings:

| Value | Name   | Value | Name  | Value | Name  |
|-------|--------|-------|-------|-------|-------|
| 0     | BE     | 26    | AF31  | 40    | CS5   |
| 8     | CS1    | 28    | AF32  | 44    | VA    |
| 10    | AF11   | 30    | AF33  | 46    | EF    |
| 12    | AF12   | 32    | CS4   | 48    | CS6   |
| 14    | AF13   | 34    | AF41  | 56    | CS7   |
| 16    | CS2    | 36    | AF42  |       |       |
| 18    | AF21   | 38    | AF43  |       |       |
| 20    | AF22   |       |       |       |       |
| 22    | AF23   |       |       |       |       |
| 24    | CS3    |       |       |       |       |

### Identifying loose initiations

A flow_open message with `sender_is_1: null` is a loose initiation. The
handshake was not observed, so:

- `handshake_ms`, `window_scale_*`, `init_rcv_wnd_*`, `ja4t_*` are all null
- Sender/receiver attribution is unavailable
- The first flow_tick values may not represent a complete interval

### Handling null values

| Scenario                    | Fields affected                        | Reason                                     |
|----------------------------|----------------------------------------|--------------------------------------------|
| Loose initiation           | `sender_is_1`, handshake fields = null | 3WHS not observed                          |
| No RTT samples             | `rtt_ms` = null                        | Idle flow or no ACK-based samples          |
| No window scale in SYN     | `window_scale_1/2` = null              | Endpoint did not include TCP option kind 3 |
| Gateway/undiscovered device| `mac_1/2` = null                       | Device not in ExtraHop discovery table     |

---

## Sample messages

### flow_open (3WHS observed)

```json
{
  "version": "3.2.0",
  "msg_type": "flow_open",
  "ts": 1711900800000,
  "flow_id": "FMak3xB7hMC",
  "ip_1": "10.1.2.3",
  "port_1": 8583,
  "mac_1": "00:1a:2b:3c:4d:5e",
  "ip_2": "10.4.5.6",
  "port_2": 8583,
  "mac_2": "00:6f:7e:8d:9c:ab",
  "sender_is_1": true,
  "ip_proto": "TCP",
  "ip_version": "IPv4",
  "vlan": 100,
  "handshake_ms": 1.23,
  "window_scale_1": 7,
  "window_scale_2": 7,
  "init_rcv_wnd_1": 65535,
  "init_rcv_wnd_2": 65535,
  "ja4t_1": "1024_2_1460_8_1-2-4-8-3:7",
  "ja4t_2": "65535_2_1460_7_1-2-4-8-3:7"
}
```

### flow_open (loose initiation)

```json
{
  "version": "3.2.0",
  "msg_type": "flow_open",
  "ts": 1711900800000,
  "flow_id": "GNbl4yC8iND",
  "ip_1": "10.1.2.3",
  "port_1": 8583,
  "mac_1": "00:1a:2b:3c:4d:5e",
  "ip_2": "10.4.5.6",
  "port_2": 8583,
  "mac_2": "00:6f:7e:8d:9c:ab",
  "sender_is_1": null,
  "ip_proto": "TCP",
  "ip_version": "IPv4",
  "vlan": 100,
  "handshake_ms": null,
  "window_scale_1": null,
  "window_scale_2": null,
  "init_rcv_wnd_1": null,
  "init_rcv_wnd_2": null,
  "ja4t_1": null,
  "ja4t_2": null
}
```

### flow_tick

```json
{
  "version": "3.2.0",
  "msg_type": "flow_tick",
  "ts": 1711900830000,
  "flow_id": "FMak3xB7hMC",
  "flow_age": 30.1,
  "ip_1": "10.1.2.3",
  "port_1": 8583,
  "ip_2": "10.4.5.6",
  "port_2": 8583,
  "sender_is_1": true,
  "rtt_ms": 2.45,
  "retrans_bytes_1": 0,
  "retrans_bytes_2": 1480,
  "rto_1": 0,
  "rto_2": 1,
  "zero_wnd_1": 0,
  "zero_wnd_2": 0,
  "rcv_wnd_throttle_1": 0,
  "rcv_wnd_throttle_2": 0,
  "nagle_delay_1": 0,
  "nagle_delay_2": 0,
  "l4_bytes_1": 52400,
  "l4_bytes_2": 48200,
  "pkts_1": 380,
  "pkts_2": 350,
  "l2_bytes_1": 54800,
  "l2_bytes_2": 50600,
  "dscp_1": 46,
  "dscp_2": 46,
  "frag_pkts_1": 0,
  "frag_pkts_2": 0,
  "overlap_segments_1": 0,
  "overlap_segments_2": 0
}
```

### flow_close

```json
{
  "version": "3.2.0",
  "msg_type": "flow_close",
  "ts": 1711987200000,
  "flow_id": "FMak3xB7hMC",
  "flow_age": 86400.5,
  "ip_1": "10.1.2.3",
  "port_1": 8583,
  "ip_2": "10.4.5.6",
  "port_2": 8583,
  "sender_is_1": true,
  "shutdown_1": true,
  "shutdown_2": true,
  "reset_1": false,
  "reset_2": false,
  "aborted_1": false,
  "aborted_2": false,
  "expired": false
}
```

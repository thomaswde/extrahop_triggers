# **TCP Flow Health Monitor**

**Export:** Kafka Open Data Stream (ODS), one object per message, one message per event  
**Encoding:** JSON (one message per event)  
**Topic:** Configured at trigger deployment

---

## **Overview**

This trigger emits per-flow TCP health telemetry from ExtraHop into Kafka. It is designed for monitoring peer-to-peer TCP connections (e.g. ISO 8583\) where both endpoints use static ports and the socket tuple is long-lived.

Three distinct message types are emitted over the lifetime of a flow:

| msg\_type | ExtraHop event | Fires | Purpose |
| :---- | :---- | :---- | :---- |
| `flow_open` | TCP\_OPEN | Once per flow | Birth certificate \- identity \+ handshake |
| `flow_tick` | FLOW\_TICK | Per turn | 128 packets  | Periodic TCP health snapshot |
| `flow_close` | TCP\_CLOSE | Once per flow | Death certificate \- termination status |

All messages share a common envelope (version, msg\_type, ts, flow\_id) and a consistent positional naming convention described below.

---

## **Positional convention (\_1 / \_2)**

All per-endpoint fields use a `_1` / `_2` suffix. These positions are assigned by the ExtraHop platform when the flow is created and **remain consistent for the entire lifetime of the flow id**. They do not necessarily imply client, server, source, or destination \- they are arbitrary but stable identifiers.

The `flow_open` message establishes what each position represents by providing `ip_1`, `port_1`, `ip_2`, `port_2`. Downstream consumers should use these fields to build a lookup (e.g. "position 1 \= 10.1.2.3:8583, position 2 \= 10.4.5.6:8583") and apply business labels as needed.

Every subsequent `flow_tick` and `flow_close` message for the same `flow_id` uses the same positional assignment. Counters ending in `_1` always refer to the same endpoint as `ip_1` from the open message.

---

## **Common envelope**

Present in **every** message type.

| Field | Type | Description |
| :---- | :---- | :---- |
| `version` | string | Trigger version (e.g. `"3.1.0"`). Use for schema compatibility. |
| `msg_type` | string | One of `"flow_open"`, `"flow_tick"`, `"flow_close"`. |
| `ts` | integer | Message emission time. Epoch milliseconds from `Date.now()`. |
| `flow_id` | string | ExtraHop-assigned unique flow identifier. Stable across all events for a given TCP connection. Join key. |

---

## **flow\_open**

Emitted **once** when the TCP 3-way handshake completes. Contains everything needed to identify the two endpoints and the parameters they negotiated at connection establishment.

### **Identity**

| Field | Type | Description |
| :---- | :---- | :---- |
| `ip_1` | string|null | IPv4 or IPv6 address of endpoint 1\. String representation. |
| `port_1` | integer | TCP port of endpoint 1\. |
| `mac_1` | string|null | MAC address of endpoint 1 (colon-separated). Null if the device is not discovered or is a gateway. |
| `ip_2` | string|null | IPv4 or IPv6 address of endpoint 2\. |
| `port_2` | integer | TCP port of endpoint 2\. |
| `mac_2` | string|null | MAC address of endpoint 2\. |

### **Network context**

| Field | Type | Description |
| :---- | :---- | :---- |
| `ip_proto` | string|null | IP protocol name (e.g. `"TCP"`). |
| `ip_version` | string|null | IP version (e.g. `"IPv4"`, `"IPv6"`). |
| `vlan` | integer | 802.1Q VLAN ID. `0` if untagged or unavailable. |

### **TCP handshake parameters**

| Field | Type | Treatment | Description |
| :---- | :---- | :---- | :---- |
| `handshake_ms` | number|null | Point-in-time | Time to complete the 3-way handshake, in milliseconds. Null if handshake was not observed (mid-stream pickup). |
| `window_scale_1` | integer|null | Point-in-time | TCP window scale factor negotiated by endpoint 1 (from TCP option kind 3). Null if not present in SYN/SYN-ACK. |
| `window_scale_2` | integer|null | Point-in-time | TCP window scale factor negotiated by endpoint 2\. |
| `init_rcv_wnd_1` | integer|null | Point-in-time | Initial TCP receive window size advertised by endpoint 1 during the handshake, in bytes. |
| `init_rcv_wnd_2` | integer|null | Point-in-time | Initial TCP receive window size advertised by endpoint 2\. |

### **Fingerprints**

| Field | Type | Treatment | Description |
| :---- | :---- | :---- | :---- |
| `ja4t_1` | string|null | Point-in-time | JA4T fingerprint for endpoint 1 (the TCP client's SYN). Encodes window size, TCP options, MSS, and window scale. |
| `ja4t_2` | string|null | Point-in-time | JA4TS fingerprint for endpoint 2 (the TCP server's SYN-ACK). |

---

## **flow\_tick**

Emitted on **every flow turn or 128 packets**, whichever comes first, on active flows. This is the primary health monitoring message. Contains latency, retransmission, and throughput counters.

### **Important: cumulative vs. per-interval semantics**

Most counters in this message are **cumulative since flow start**, not deltas since the last tick. The warehouse must compute deltas between successive ticks to derive per-interval values.

**The one exception** is `rtt_ms`, which is a per-interval median \- it represents the median RTT observed *since the last FLOW\_TICK fired*, not a running lifetime value.

### **Identity echo**

| Field | Type | Description |
| ----- | ----- | ----- |
| `ip_1` | string|null | Same as flow\_open. Echoed for standalone processing. |
| `port_1` | integer | Same as flow\_open. |
| `ip_2` | string|null | Same as flow\_open. |
| `port_2` | integer | Same as flow\_open. |

### **Flow timing**

| Field | Type | Treatment | Description |
| ----- | ----- | ----- | ----- |
| `flow_age` | number | Point-in-time | Time elapsed since the flow was initiated, in seconds. |

### **Latency**

| Field | Type | Treatment | Description |
| ----- | ----- | ----- | ----- |
| `rtt_ms` | number|null | **Per-interval** | Median TCP round-trip time observed since the last tick, in milliseconds. Computed from ACK timing. `null` when no RTT samples exist in the interval (e.g. idle flow). **This is NOT cumulative.** |

### **Retransmission**

| Field | Type | Treatment | Description |
| ----- | ----- | ----- | ----- |
| `retrans_bytes_1` | integer | **Cumulative** | Total bytes retransmitted by endpoint 1 since flow start. Compute `delta = tick_N - tick_N-1` for per-interval retransmission volume. |
| `retrans_bytes_2` | integer | **Cumulative** | Total bytes retransmitted by endpoint 2 since flow start. |
| `rto_1` | integer | **Cumulative** | Count of retransmission timeout events for endpoint 1 since flow start. An RTO indicates the sender's retransmit timer expired without receiving an ACK. |
| `rto_2` | integer | **Cumulative** | Count of retransmission timeout events for endpoint 2\. |

### **Window health**

| Field | Type | Treatment | Description |
| ----- | ----- | ----- | ----- |
| `zero_wnd_1` | integer | **Cumulative** | Count of TCP zero-window advertisements sent by endpoint 1 since flow start. Indicates the receiver's buffer is full and it is asking the sender to stop transmitting. |
| `zero_wnd_2` | integer | **Cumulative** | Count of zero-window advertisements from endpoint 2\. |
| `rcv_wnd_throttle_1` | integer | **Cumulative** | Count of receive-window throttle events for endpoint 1 since flow start. Indicates the receive window shrank enough to throttle the sender. |
| `rcv_wnd_throttle_2` | integer | **Cumulative** | Receive-window throttles for endpoint 2\. |

### **Nagle**

| Field | Type | Treatment | Description |
| ----- | ----- | ----- | ----- |
| `nagle_delay_1` | integer | **Cumulative** | Count of Nagle-algorithm-induced delays for endpoint 1 since flow start. Nagle delays occur when the TCP stack holds a small segment to coalesce it with subsequent data. |
| `nagle_delay_2` | integer | **Cumulative** | Nagle delays for endpoint 2\. |

### **Throughput counters**

All throughput counters are **cumulative since flow start**. To compute per-interval rates:

```
delta_bytes = tick_N.l4_bytes_1 - tick_N_minus_1.l4_bytes_1
interval_ms = tick_N.ts - tick_N_minus_1.ts
mbps        = (delta_bytes * 8) / (interval_ms * 1000)
pps         = (tick_N.pkts_1 - tick_N_minus_1.pkts_1) / (interval_ms / 1000)
```

| Field | Type | Treatment | Description |
| ----- | ----- | ----- | ----- |
| `l4_bytes_1` | integer | **Cumulative** | L4 payload bytes transmitted by endpoint 1 since flow start. Excludes L2/L3 headers. |
| `l4_bytes_2` | integer | **Cumulative** | L4 payload bytes from endpoint 2\. |
| `l2_bytes_1` | integer | **Cumulative** | L2 bytes (including Ethernet headers) from endpoint 1 since flow start. |
| `l2_bytes_2` | integer | **Cumulative** | L2 bytes from endpoint 2\. |
| `pkts_1` | integer | **Cumulative** | Packet count from endpoint 1 since flow start. |
| `pkts_2` | integer | **Cumulative** | Packet count from endpoint 2\. |

### **DSCP**

| Field | Type | Treatment | Description |
| ----- | ----- | ----- | ----- |
| `dscp_1` | integer | **Last-observed** | The most recent DSCP numeric value in packets from endpoint 1\. Not cumulative \- this is the last value seen, not a count. See RFC 2474 for code-to-name mapping. Common values: 0=Best Effort, 46=EF, 34=AF41. |
| `dscp_2` | integer | **Last-observed** | Most recent DSCP value from endpoint 2\. |

### **IP fragmentation and TCP overlap**

| Field | Type | Treatment | Description |
| ----- | ----- | ----- | ----- |
| `frag_pkts_1` | integer | **Cumulative** | Count of IP-fragmented packets from endpoint 1 since flow start. |
| `frag_pkts_2` | integer | **Cumulative** | Fragmented packets from endpoint 2\. |
| `overlap_segments_1` | integer | **Cumulative** | Count of non-identical overlapping TCP segments from endpoint 1 since flow start. Two or more segments contained data for the same byte range. May indicate retransmission anomalies or injection. |
| `overlap_segments_2` | integer | **Cumulative** | Overlapping segments from endpoint 2\. |

---

## **flow\_close**

Emitted **once** when the TCP connection terminates. Provides per-endpoint termination status. No inference required \- these booleans reflect the observed TCP state machine.

### **Identity echo**

| Field | Type | Description |
| :---- | :---- | :---- |
| `ip_1` | string|null | Same as flow\_open. |
| `port_1` | integer | Same as flow\_open. |
| `ip_2` | string|null | Same as flow\_open. |
| `port_2` | integer | Same as flow\_open. |

### **Flow timing**

| Field | Type | Description |
| :---- | :---- | :---- |
| `flow_age` | number | Total duration of the flow from initiation to close, in seconds. |

### **Termination status**

| Field | Type | Description |
| :---- | :---- | :---- |
| `aborted_1` | boolean | `true` if endpoint 1 sent a TCP RST, terminating the connection abruptly. `false` for graceful close or expiry. |
| `aborted_2` | boolean | `true` if endpoint 2 sent a TCP RST. |
| `shutdown_1` | boolean | `true` if endpoint 1 initiated a graceful TCP shutdown (sent FIN). |
| `shutdown_2` | boolean | `true` if endpoint 2 initiated a graceful TCP shutdown. |
| `expired` | boolean | `true` if the flow timed out without any proper TCP termination (no FIN, no RST \- the ExtraHop platform expired the flow from its tracking table). |

### **Interpreting termination**

| shutdown\_1 | shutdown\_2 | aborted\_1 | aborted\_2 | expired | Meaning |
| :---- | :---- | :---- | :---- | :---- | :---- |
| true | true | false | false | false | Normal graceful close (both sides sent FIN) |
| true | false | false | false | false | Half-close: endpoint 1 sent FIN, endpoint 2 has not yet |
| false | false | true | false | false | Endpoint 1 reset the connection |
| false | false | false | true | false | Endpoint 2 reset the connection |
| false | false | true | true | false | Both sides sent RST (rare) |
| false | false | false | false | true | Connection expired without termination |

---

## **Warehouse guidance**

### **Joining flow lifecycle**

All three message types share `flow_id`. A complete flow record is:

```sql
SELECT
    o.flow_id,
    o.ip_1, o.port_1, o.ip_2, o.port_2,
    o.handshake_ms,
    t.*,
    c.aborted_1, c.aborted_2, c.shutdown_1, c.shutdown_2, c.expired
FROM flow_open  o
JOIN flow_tick  t ON t.flow_id = o.flow_id
JOIN flow_close c ON c.flow_id = o.flow_id
```

### **Computing per-interval deltas**

For any cumulative field, the per-interval value is:

```
delta = tick[N].field - tick[N-1].field
```

where `tick[N-1]` is the previous tick for the same `flow_id`, ordered by `ts`.

For the **first tick** after a flow opens, there is no prior tick. Use the value as-is (it represents the cumulative total since flow start, which for a 30-second-old flow is effectively the first interval).

### **Computing rates (PPS, Mbps)**

```
interval_sec = (tick[N].ts - tick[N-1].ts) / 1000
pps  = (tick[N].pkts_1 - tick[N-1].pkts_1) / interval_sec
mbps = ((tick[N].l4_bytes_1 - tick[N-1].l4_bytes_1) * 8) / (interval_sec * 1_000_000)
```

### **DSCP name resolution**

The trigger emits numeric DSCP values. Standard mappings:

| Value | Name | Value | Name | Value | Name |
| ----- | ----- | ----- | ----- | ----- | ----- |
| 0 | BE | 26 | AF31 | 40 | CS5 |
| 8 | CS1 | 28 | AF32 | 44 | VA |
| 10 | AF11 | 30 | AF33 | 46 | EF |
| 12 | AF12 | 32 | CS4 | 48 | CS6 |
| 14 | AF13 | 34 | AF41 | 56 | CS7 |
| 16 | CS2 | 36 | AF42 |  |  |
| 18 | AF21 | 38 | AF43 |  |  |
| 20 | AF22 |  |  |  |  |
| 22 | AF23 |  |  |  |  |
| 24 | CS3 |  |  |  |  |

### **Handling late-start flows**

If the trigger is assigned to a device after a TCP connection is already established, the `flow_open` message will not exist for that flow. The first message will be a `flow_tick`. In this case:

* `window_scale`, `init_rcv_wnd`, `handshake_ms`, and `ja4t` are unavailable  
* All cumulative counters start from whatever values they had at the time the trigger first fired, not from true zero  
* The identity (`ip_1`, `port_1`, etc.) is still established via late-initialization

---

## **Sample messages**

### **flow\_open**

```json
{
  "version": "3.1.0",
  "msg_type": "flow_open",
  "ts": 1711900800000,
  "flow_id": "FMak3xB7hMC",
  "ip_1": "10.1.2.3",
  "port_1": 8583,
  "mac_1": "00:1a:2b:3c:4d:5e",
  "ip_2": "10.4.5.6",
  "port_2": 8583,
  "mac_2": "00:6f:7e:8d:9c:ab",
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

### **flow\_tick**

```json
{
  "version": "3.1.0",
  "msg_type": "flow_tick",
  "ts": 1711900830000,
  "flow_id": "FMak3xB7hMC",
  "flow_age": 30.1,
  "ip_1": "10.1.2.3",
  "port_1": 8583,
  "ip_2": "10.4.5.6",
  "port_2": 8583,
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
  "l2_bytes_1": 54800,
  "l2_bytes_2": 50600,
  "pkts_1": 380,
  "pkts_2": 350,
  "dscp_1": 46,
  "dscp_2": 46,
  "frag_pkts_1": 0,
  "frag_pkts_2": 0,
  "overlap_segments_1": 0,
  "overlap_segments_2": 0
}
```

### **flow\_close**

```json
{
  "version": "3.1.0",
  "msg_type": "flow_close",
  "ts": 1711987200000,
  "flow_id": "FMak3xB7hMC",
  "flow_age": 86400.5,
  "ip_1": "10.1.2.3",
  "port_1": 8583,
  "ip_2": "10.4.5.6",
  "port_2": 8583,
  "aborted_1": false,
  "aborted_2": false,
  "shutdown_1": true,
  "shutdown_2": true,
  "expired": false
}
```


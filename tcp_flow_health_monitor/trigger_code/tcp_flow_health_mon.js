// ============================================================================
// Title:   TCP Flow Health Monitor
// Version: 3.3.0
// Events:  TCP_OPEN, FLOW_TICK, TCP_CLOSE
//
// Purpose: Emit per-flow TCP health metrics via ODS for data warehouse
//          ingestion. Designed for durable peer-to-peer socket monitoring
//          (e.g. ISO 8583) where both endpoints use static ports.
//
// Design:  All metrics use the ExtraHop positional convention (_1 / _2).
//          Device 1 and Device 2 are assigned by the platform when the flow
//          is created and remain consistent for the flow's lifetime.
//
//          The identity of each position (IP, port, MAC) is captured once at
//          TCP_OPEN and persisted in Flow.store. Every subsequent event
//          references this stored identity and emits all counters using the
//          same _1 / _2 convention, providing a stable frame of reference
//          without imposing client/server or source/dest semantics.
//
//          When the TCP 3-way handshake is observed, the trigger determines
//          which positional slot corresponds to the SYN sender and records
//          this in the sender_is_1 field. For loose flow initiations (where
//          the handshake was not observed), sender_is_1 is null.
//
//          The warehouse receives typed messages and owns all labeling,
//          rate calculations, and DSCP name resolution.
//
// Rate:    FLOW_TICK deltas are accumulated in Flow.store and emitted at
//          most once per EMIT_INTERVAL_MS (default 10 s). TCP_CLOSE flushes
//          any already-accumulated data and marks the flow closed so any
//          later FLOW_TICK emits immediately.
//
// Output:  JSON messages via ODS:
//            - flow_open:  Peer identity + TCP handshake parameters
//            - flow_tick:  Aggregated TCP health snapshot (per emit interval)
//            - flow_close: Connection termination status
// ============================================================================


// ========================= Configuration ====================================

var KAFKA_TARGET     = "";         // ODS target name configured in ExtraHop admin
var KAFKA_TOPIC      = "";         // Kafka topic for flow health messages
var VERSION          = "3.3.0";    // Schema version for warehouse
var EMIT_INTERVAL_MS = 10000;      // Min ms between flow_tick emissions (10 s)

function buildIdentity(senderIs1) {
    return {
        ip_1:        Flow.ipaddr1,
        port_1:      Flow.port1,
        mac_1:       Flow.device1 ? Flow.device1.hwaddr : null,
        ip_2:        Flow.ipaddr2,
        port_2:      Flow.port2,
        mac_2:       Flow.device2 ? Flow.device2.hwaddr : null,
        sender_is_1: senderIs1
    };
}

function ensureIdentity() {
    var identity = Flow.store.identity;
    if (!identity) {
        identity = buildIdentity(null);
        Flow.store.identity = identity;
    }
    return identity;
}

function getTcpOptionValue(options, kind) {
    if (!options) { return null; }

    for (var i = 0; i < options.length; i++) {
        var option = options[i];
        if (option && option.kind === kind) {
            return option.value !== undefined ? option.value : null;
        }
    }

    return null;
}

function buildTickMessage(identity, accum, timestamp) {
    return {
        version:  VERSION,
        msg_type: "flow_tick",
        ts:       timestamp,
        flow_id:  Flow.id,
        flow_age: Flow.age,

        ip_1:        identity.ip_1,
        port_1:      identity.port_1,
        ip_2:        identity.ip_2,
        port_2:      identity.port_2,
        sender_is_1: identity.sender_is_1,

        rtt_ms:             accum.rtt_ms,
        retrans_bytes_1:    accum.retrans_bytes_1,
        retrans_bytes_2:    accum.retrans_bytes_2,
        rto_1:              accum.rto_1,
        rto_2:              accum.rto_2,
        zero_wnd_1:         accum.zero_wnd_1,
        zero_wnd_2:         accum.zero_wnd_2,
        rcv_wnd_throttle_1: accum.rcv_wnd_throttle_1,
        rcv_wnd_throttle_2: accum.rcv_wnd_throttle_2,
        nagle_delay_1:      accum.nagle_delay_1,
        nagle_delay_2:      accum.nagle_delay_2,
        l4_bytes_1:         accum.l4_bytes_1,
        l4_bytes_2:         accum.l4_bytes_2,
        pkts_1:             accum.pkts_1,
        pkts_2:             accum.pkts_2,
        l2_bytes_1:         accum.l2_bytes_1,
        l2_bytes_2:         accum.l2_bytes_2,
        dscp_1:             accum.dscp_1,
        dscp_2:             accum.dscp_2,
        frag_pkts_1:        accum.frag_pkts_1,
        frag_pkts_2:        accum.frag_pkts_2,
        overlap_segments_1: accum.overlap_segments_1,
        overlap_segments_2: accum.overlap_segments_2
    };
}

// ========================= TCP_OPEN =========================================
// Fires once per flow when a TCP connection is initiated. If the 3-way
// handshake was observed, handshake parameters and sender identification
// are available. For loose initiations (mid-stream pickup), handshake-
// dependent values will be null.
// ============================================================================

if (event === "TCP_OPEN") {

    // Determine if we observed the 3-way handshake.
    // A non-null, non-NaN handshakeTime > 0 means we saw it.
    var hsTime    = TCP.handshakeTime;
    var saw3whs   = (hsTime !== null && hsTime === hsTime && hsTime > 0);

    // When the handshake was observed, we know which side sent the SYN.
    // Map that knowledge to our positional convention.
    var senderIs1 = saw3whs ? (Flow.client.port === Flow.port1) : null;

    // Persist for FLOW_TICK and TCP_CLOSE
    var identity = buildIdentity(senderIs1);
    Flow.store.identity = identity;

    // TCP options — only meaningful when 3WHS was observed
    var ws_1  = null,
        ws_2  = null,
        wnd_1 = null,
        wnd_2 = null,
        ja4_1 = null,
        ja4_2 = null;

    if (saw3whs) {
        ws_1  = getTcpOptionValue(TCP.options1, 3);
        ws_2  = getTcpOptionValue(TCP.options2, 3);
        wnd_1 = TCP.initRcvWndSize1;
        wnd_2 = TCP.initRcvWndSize2;
        ja4_1 = TCP.ja4TCPClient || null;
        ja4_2 = TCP.ja4TCPServer || null;
    }

    var message = {
        version:  VERSION,
        msg_type: "flow_open",
        ts:       Date.now(),
        flow_id:  Flow.id,

        // Peer identity
        ip_1:   identity.ip_1,
        port_1: identity.port_1,
        mac_1:  identity.mac_1,
        ip_2:   identity.ip_2,
        port_2: identity.port_2,
        mac_2:  identity.mac_2,

        // Sender identification
        // true:  3WHS observed, position 1 is the SYN sender
        // false: 3WHS observed, position 2 is the SYN sender
        // null:  loose init, sender unknown
        sender_is_1: identity.sender_is_1,

        // Network context
        ip_proto:   Flow.ipproto,
        ip_version: Flow.ipver,
        vlan:       Flow.vlan || 0,

        // TCP handshake (null on loose initiations)
        handshake_ms:   saw3whs ? hsTime : null,
        window_scale_1: ws_1,
        window_scale_2: ws_2,
        init_rcv_wnd_1: wnd_1,
        init_rcv_wnd_2: wnd_2,

        // JA4 TCP fingerprints (null on loose initiations)
        ja4t_1: ja4_1,
        ja4t_2: ja4_2
    };

    Remote.Kafka(KAFKA_TARGET).send(KAFKA_TOPIC, JSON.stringify(message));
}


// ========================= FLOW_TICK ========================================
// Fires on each flow turn or after 128 bytes of payload, whichever is first.
//
// To reduce Kafka message volume, deltas from each tick are accumulated in
// Flow.store.accum and only emitted when EMIT_INTERVAL_MS has elapsed since
// the last send. TCP_CLOSE flushes any already-accumulated data; if a final
// FLOW_TICK arrives after TCP_CLOSE, it bypasses the interval and emits
// immediately.
//
// Counter values from the platform are deltas since the last FLOW_TICK.
// RTT is the median observed since the last tick — we keep the last non-null
// value seen across the accumulation window.
// DSCP is last-observed — we keep the latest value.
// ============================================================================

if (event === "FLOW_TICK") {

    // Retrieve identity from Flow.store, or late-init if we missed TCP_OPEN
    var id = ensureIdentity();

    // Initialize the accumulator on first tick
    var a = Flow.store.accum;
    if (!a) {
        a = {
            retrans_bytes_1: 0, retrans_bytes_2: 0,
            rto_1: 0,           rto_2: 0,
            zero_wnd_1: 0,      zero_wnd_2: 0,
            rcv_wnd_throttle_1: 0, rcv_wnd_throttle_2: 0,
            nagle_delay_1: 0,   nagle_delay_2: 0,
            l4_bytes_1: 0,      l4_bytes_2: 0,
            pkts_1: 0,          pkts_2: 0,
            l2_bytes_1: 0,      l2_bytes_2: 0,
            frag_pkts_1: 0,     frag_pkts_2: 0,
            overlap_segments_1: 0, overlap_segments_2: 0,
            rtt_ms: null,
            dscp_1: 0,          dscp_2: 0
        };
        Flow.store.accum = a;
    }
    if (!Flow.store.lastEmitTs) {
        Flow.store.lastEmitTs = Date.now();
    }

    // Accumulate delta fields (sum across ticks)
    a.retrans_bytes_1    += TCP.retransBytes1;
    a.retrans_bytes_2    += TCP.retransBytes2;
    a.rto_1              += Flow.rto1;
    a.rto_2              += Flow.rto2;
    a.zero_wnd_1         += TCP.zeroWnd1;
    a.zero_wnd_2         += TCP.zeroWnd2;
    a.rcv_wnd_throttle_1 += Flow.rcvWndThrottle1;
    a.rcv_wnd_throttle_2 += Flow.rcvWndThrottle2;
    a.nagle_delay_1      += Flow.nagleDelay1;
    a.nagle_delay_2      += Flow.nagleDelay2;
    a.l4_bytes_1         += Flow.bytes1;
    a.l4_bytes_2         += Flow.bytes2;
    a.pkts_1             += Flow.pkts1;
    a.pkts_2             += Flow.pkts2;
    a.l2_bytes_1         += Flow.l2Bytes1;
    a.l2_bytes_2         += Flow.l2Bytes2;
    a.frag_pkts_1        += Flow.fragPkts1;
    a.frag_pkts_2        += Flow.fragPkts2;
    a.overlap_segments_1 += Flow.overlapSegments1;
    a.overlap_segments_2 += Flow.overlapSegments2;

    // RTT: keep the last non-null median seen in this window
    var rtt = Flow.roundTripTime;
    if (rtt !== null && rtt === rtt) {   // NaN !== NaN, so this filters NaN
        a.rtt_ms = rtt;
    }

    // DSCP: last-observed, just overwrite
    a.dscp_1 = Flow.dscp1;
    a.dscp_2 = Flow.dscp2;

    // Emit only when the interval has elapsed. Closed flows can receive final
    // FLOW_TICK events after TCP_CLOSE, so emit those immediately.
    var now = Date.now();
    var closed = Flow.store.closed || false;
    if (!closed && ((now - Flow.store.lastEmitTs) < EMIT_INTERVAL_MS)) { return; }

    var message = buildTickMessage(id, a, now);
    Remote.Kafka(KAFKA_TARGET).send(KAFKA_TOPIC, JSON.stringify(message));

    // Reset accumulator and timestamp
    Flow.store.lastEmitTs = now;
    Flow.store.accum = null;
}


// ========================= TCP_CLOSE ========================================
// Fires once when the TCP connection terminates.
//
// If there is unflushed data in Flow.store.accum (accumulated since the last
// emitted tick), we flush it as a flow_tick before emitting flow_close. The
// flow is also marked closed so any later FLOW_TICK bypasses the rate limiter
// and emits the true final deltas immediately.
//
// Terminology:
//   shutdown = this endpoint sent a FIN (graceful close)
//   reset    = this endpoint sent a RST after the flow was established
//   aborted  = this endpoint sent a RST before the flow was established
// ============================================================================

if (event === "TCP_CLOSE") {

    Flow.store.closed = true;
    var id = ensureIdentity();

    // Determine which positional slot maps to client vs server
    var clientPort = Flow.client.port;
    var clientIs1  = (clientPort === Flow.port1);

    // Flush any remaining accumulated tick data
    var a = Flow.store.accum;
    if (a) {
        var flushMsg = buildTickMessage(id, a, Date.now());
        Remote.Kafka(KAFKA_TARGET).send(KAFKA_TOPIC, JSON.stringify(flushMsg));
        Flow.store.accum = null;
    }

    // Read role-based termination booleans
    var clientShutdown = Flow.client.isShutdown || false;
    var serverShutdown = Flow.server.isShutdown || false;
    var clientReset    = TCP.client.isReset     || false;
    var serverReset    = TCP.server.isReset     || false;
    var clientAborted  = TCP.client.isAborted   || false;
    var serverAborted  = TCP.server.isAborted   || false;

    var message = {
        version:  VERSION,
        msg_type: "flow_close",
        ts:       Date.now(),
        flow_id:  Flow.id,
        flow_age: Flow.age,

        // Identity echo
        ip_1:        id.ip_1,
        port_1:      id.port_1,
        ip_2:        id.ip_2,
        port_2:      id.port_2,
        sender_is_1: id.sender_is_1,

        // Graceful shutdown — this endpoint sent FIN
        shutdown_1: clientIs1 ? clientShutdown : serverShutdown,
        shutdown_2: clientIs1 ? serverShutdown : clientShutdown,

        // Reset after establishment — this endpoint sent RST post-handshake
        reset_1: clientIs1 ? clientReset : serverReset,
        reset_2: clientIs1 ? serverReset : clientReset,

        // Aborted before establishment — this endpoint sent RST pre-handshake
        aborted_1: clientIs1 ? clientAborted : serverAborted,
        aborted_2: clientIs1 ? serverAborted : clientAborted,

        // Expiry — flow timed out without proper termination
        expired: Flow.isExpired || false
    };

    Remote.Kafka(KAFKA_TARGET).send(KAFKA_TOPIC, JSON.stringify(message));
}

// ============================================================================
// Title:   TCP Flow Health Monitor
// Version: 3.2.1
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
// Output:  JSON messages via ODS:
//            - flow_open:  Peer identity + TCP handshake parameters
//            - flow_tick:  Periodic TCP health snapshot (per turn or 128 bytes)
//            - flow_close: Connection termination status
// ============================================================================


// ========================= Configuration ====================================

var KAFKA_TARGET  = "";            // ODS target name configured in ExtraHop admin
var KAFKA_TOPIC = "";              // Kafka topic for flow health message
var VERSION = "3.2.0";             // Schema version for warehouse

// ========================= TCP_OPEN =========================================
// Fires once per flow when a TCP connection is initiated. If the 3-way
// handshake was observed, handshake parameters and sender identification
// are available. For loose initiations (mid-stream pickup), handshake-
// dependent values will be null.
// ============================================================================

if (event === "TCP_OPEN") {

    // Positional identity — stable for the lifetime of this flow
    var ip_1  = Flow.ipaddr1,
        ip_2  = Flow.ipaddr2,
        mac_1 = Flow.device1 ? Flow.device1.hwaddr : null,
        mac_2 = Flow.device2 ? Flow.device2.hwaddr : null;

    // Determine if we observed the 3-way handshake.
    // A non-null, non-NaN handshakeTime > 0 means we saw it.
    var hsTime    = TCP.handshakeTime;
    var saw3whs   = (hsTime !== null && hsTime === hsTime && hsTime > 0);

    // When the handshake was observed, we know which side sent the SYN.
    // Map that knowledge to our positional convention.
    var senderIs1 = saw3whs ? (Flow.client.port === Flow.port1) : null;

    var identity = {
        ip_1:        ip_1,
        port_1:      Flow.port1,
        mac_1:       mac_1,
        ip_2:        ip_2,
        port_2:      Flow.port2,
        mac_2:       mac_2,
        sender_is_1: senderIs1
    };

    // Persist for FLOW_TICK and TCP_CLOSE
    Flow.store.identity = identity;

    // TCP options — only meaningful when 3WHS was observed
    var ws_1  = null,
        ws_2  = null,
        wnd_1 = null,
        wnd_2 = null,
        ja4_1 = null,
        ja4_2 = null;

    if (saw3whs) {
        var opts1 = TCP.options1;
        var opts2 = TCP.options2;
        var wsOpt1 = opts1 ? opts1.find(function(opt) { return opt.kind === 3; }) : null;
        var wsOpt2 = opts2 ? opts2.find(function(opt) { return opt.kind === 3; }) : null;
        ws_1  = (wsOpt1 && wsOpt1.value !== undefined) ? wsOpt1.value : null;
        ws_2  = (wsOpt2 && wsOpt2.value !== undefined) ? wsOpt2.value : null;
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
// Fires on each flow turn (a complete request-response exchange) or after
// 128 bytes of payload in one direction, whichever comes first.
//
// Counter values are deltas since the last FLOW_TICK.
// RTT is the median observed since the last tick.
// ============================================================================

if (event === "FLOW_TICK") {

    // Retrieve identity from Flow.store, or late-init if we missed TCP_OPEN
    var id = Flow.store.identity;
    if (!id) {
        id = {
            ip_1:        Flow.ipaddr1,
            port_1:      Flow.port1,
            mac_1:       Flow.device1 ? Flow.device1.hwaddr : null,
            ip_2:        Flow.ipaddr2,
            port_2:      Flow.port2,
            mac_2:       Flow.device2 ? Flow.device2.hwaddr : null,
            sender_is_1: null
        };
        Flow.store.identity = id;
    }

    // RTT — NaN when no ACK samples exist in this interval
    var rtt = Flow.roundTripTime;

    var message = {
        version:  VERSION,
        msg_type: "flow_tick",
        ts:       Date.now(),
        flow_id:  Flow.id,
        flow_age: Flow.age,

        // Identity echo
        ip_1:        id.ip_1,
        port_1:      id.port_1,
        ip_2:        id.ip_2,
        port_2:      id.port_2,
        sender_is_1: id.sender_is_1,

        // Latency — median RTT for this tick interval; null when no samples
        rtt_ms: (rtt === rtt) ? rtt : null,

        // Retransmission bytes
        retrans_bytes_1: TCP.retransBytes1,
        retrans_bytes_2: TCP.retransBytes2,

        // Retransmission timeouts
        rto_1: Flow.rto1,
        rto_2: Flow.rto2,

        // Zero windows
        zero_wnd_1: TCP.zeroWnd1,
        zero_wnd_2: TCP.zeroWnd2,

        // Receive window throttles
        rcv_wnd_throttle_1: Flow.rcvWndThrottle1,
        rcv_wnd_throttle_2: Flow.rcvWndThrottle2,

        // Nagle delays
        nagle_delay_1: Flow.nagleDelay1,
        nagle_delay_2: Flow.nagleDelay2,

        // Throughput — bytes and packets
        l4_bytes_1: Flow.bytes1,
        l4_bytes_2: Flow.bytes2,
        pkts_1:     Flow.pkts1,
        pkts_2:     Flow.pkts2,

        // L2 bytes
        l2_bytes_1: Flow.l2Bytes1,
        l2_bytes_2: Flow.l2Bytes2,

        // DSCP (last observed numeric value per direction)
        dscp_1: Flow.dscp1,
        dscp_2: Flow.dscp2,

        // Fragment and overlap indicators
        frag_pkts_1:        Flow.fragPkts1,
        frag_pkts_2:        Flow.fragPkts2,
        overlap_segments_1: Flow.overlapSegments1,
        overlap_segments_2: Flow.overlapSegments2
    };

    Remote.Kafka(KAFKA_TARGET).send(KAFKA_TOPIC, JSON.stringify(message));
}


// ========================= TCP_CLOSE ========================================
// Fires once when the TCP connection terminates.
// Provides definitive per-endpoint termination status.
//
// Terminology:
//   shutdown = this endpoint sent a FIN (graceful close)
//   reset    = this endpoint sent a RST after the flow was established
//   aborted  = this endpoint sent a RST before the flow was established
// ============================================================================

if (event === "TCP_CLOSE") {

    var id = Flow.store.identity;

    // Determine which positional slot maps to client vs server
    var clientPort = Flow.client.port;
    var clientIs1  = (clientPort === Flow.port1);

    // If we never captured identity or saw a FLOW_TICK, do not emit a flow_close
    if (!id) { return; }

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

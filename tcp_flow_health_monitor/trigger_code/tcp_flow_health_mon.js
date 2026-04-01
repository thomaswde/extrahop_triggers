// ============================================================================
// Title:   TCP Flow Health Monitor
// Version: 3.1.0
// Events:  TCP_OPEN, FLOW_TICK, TCP_CLOSE
//
// Purpose: Emit per-flow TCP health metrics to Kafka for data warehouse
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
//          The warehouse receives typed messages and owns all labeling,
//          rate calculations, and DSCP name resolution.
//
// Output:  JSON messages to Kafka ODS:
//            - flow_open:  Peer identity + TCP handshake parameters
//            - flow_tick:  Periodic TCP health snapshot (128b or flow turn)
//            - flow_close: Connection termination status
// ============================================================================


// ========================= Configuration ====================================

var KAFKA_TARGET = "";       // ODS target name configured in ExtraHop admin
var KAFKA_TOPIC = "";       // Kafka topic for flow health messages
var VERSION = "3.1.0";


// ========================= TCP_OPEN =========================================
// Fires once when the 3-way handshake completes.
// Captures the identity of both positional endpoints and TCP negotiation
// parameters. Persists identity in Flow.store for all subsequent events.
// ============================================================================

if (event === "TCP_OPEN") {
    // Build the identity object that all events will reference.
    // Map to positional slots
    var ip_1 = Flow.ipaddr1.toString(),
        ip_2 = Flow.ipaddr2.toString(),
        mac_1 = Flow.device1 ? Flow.device1.hwaddr : null,
        mac_2 = Flow.device2 ? Flow.device2.hwaddr : null;

    var identity = {
        ip_1: ip_1,
        port_1: Flow.port1,
        mac_1: mac_1,
        ip_2: ip_2,
        port_2: Flow.port2,
        mac_2: mac_2
    };

    // Persist for FLOW_TICK and TCP_CLOSE
    Flow.store.identity = identity;

    // Extract window scale (TCP option kind 3) from each side of the handshake.
    var ws_1 = TCP.options1.find(opt => opt.kind === 3),
        ws_2 = TCP.options2.find(opt => opt.kind === 3),
        wnd_1 = TCP.initRcvWndSize1,
        wnd_2 = TCP.initRcvWndSize2;

    var message = {
        version: VERSION,
        msg_type: "flow_open",
        ts: Date.now(),
        flow_id: Flow.id,

        // Peer identity
        ip_1: identity.ip_1,
        port_1: identity.port_1,
        mac_1: identity.mac_1,
        ip_2: identity.ip_2,
        port_2: identity.port_2,
        mac_2: identity.mac_2,

        // Network context
        ip_proto: Flow.ipproto,
        ip_version: Flow.ipver,
        vlan: Flow.vlan || 0,

        // TCP handshake
        handshake_ms: TCP.handshakeTime,
        window_scale_1: (ws_1 && ws_1.value !== undefined) ? ws_1.value : null,
        window_scale_2: (ws_2 && ws_2.value !== undefined) ? ws_2.value : null,
        init_rcv_wnd_1: wnd_1,
        init_rcv_wnd_2: wnd_2,

        // JA4 TCP fingerprints
        ja4t_1: TCP.ja4TCPClient || null,
        ja4t_2: TCP.ja4TCPServer || null
    };
    //debug(JSON.stringify(message))
    Remote.Kafka(KAFKA_TARGET).send(KAFKA_TOPIC, JSON.stringify(message));

}


// ========================= FLOW_TICK ========================================
// Fires every flow turn or 128 packets on active flows.
// All counter values are CUMULATIVE since flow start — not deltas.
// RTT is the median observed since the LAST tick — not cumulative.
// The warehouse computes per-interval deltas and rates.
// ============================================================================

if (event === "FLOW_TICK") {

    // Retrieve identity from Flow.store, or late-init if we missed TCP_OPEN
    var id = Flow.store.identity;
    if (!id) {
        id = {
            ip_1: Flow.ipaddr1.toString(),
            port_1: Flow.port1,
            mac_1: Flow.device1 ? Flow.device1.hwaddr : null,
            ip_2: Flow.ipaddr2.toString(),
            port_2: Flow.port2,
            mac_2: Flow.device2 ? Flow.device2.hwaddr : null
        };
        Flow.store.identity = id;
    }

    // RTT — NaN when no samples exist in this interval
    var rtt = Flow.roundTripTime;

    var message = {
        version: VERSION,
        msg_type: "flow_tick",
        ts: Date.now(),
        flow_id: Flow.id,
        flow_age: Flow.age,

        // Identity echo (allows standalone warehouse processing without join)
        ip_1: id.ip_1,
        port_1: id.port_1,
        ip_2: id.ip_2,
        port_2: id.port_2,

        // Latency
        // Median RTT for this tick interval. null when no ACK samples.
        rtt_ms: (rtt === rtt) ? rtt : null,

        // Retransmission bytes (cumulative)
        retrans_bytes_1: TCP.retransBytes1,
        retrans_bytes_2: TCP.retransBytes2,

        // Retransmission timeouts (cumulative count)
        rto_1: Flow.rto1,
        rto_2: Flow.rto2,

        // Zero windows (cumulative count)
        zero_wnd_1: TCP.zeroWnd1,
        zero_wnd_2: TCP.zeroWnd2,

        // Receive window throttles (cumulative count)
        rcv_wnd_throttle_1: Flow.rcvWndThrottle1,
        rcv_wnd_throttle_2: Flow.rcvWndThrottle2,

        // Nagle delays (cumulative count)
        nagle_delay_1: Flow.nagleDelay1,
        nagle_delay_2: Flow.nagleDelay2,

        // Throughput counters (all cumulative since flow start)
        l4_bytes_1: Flow.bytes1,
        l4_bytes_2: Flow.bytes2,
        l2_bytes_1: Flow.l2Bytes1,
        l2_bytes_2: Flow.l2Bytes2,
        pkts_1: Flow.pkts1,
        pkts_2: Flow.pkts2,

        // DSCP (last observed numeric value per direction)
        dscp_1: Flow.dscp1,
        dscp_2: Flow.dscp2,

        // Fragment and overlap indicators (cumulative)
        frag_pkts_1: Flow.fragPkts1,
        frag_pkts_2: Flow.fragPkts2,
        overlap_segments_1: Flow.overlapSegments1,
        overlap_segments_2: Flow.overlapSegments2
    };
    //debug(JSON.stringify(message))
    Remote.Kafka(KAFKA_TARGET).send(KAFKA_TOPIC, JSON.stringify(message));
}


// ========================= TCP_CLOSE ========================================
// Fires once when the TCP connection terminates.
// Provides definitive termination status per endpoint.
//
// Note: isAborted / isShutdown use the role-based accessor (Flow.client /
// Flow.server) because the API does not expose positional variants.
// We map them to _1 / _2 using the same port-matching logic from identity.
// ============================================================================

if (event === "TCP_CLOSE") {

    var id = Flow.store.identity;

    // Determine which positional slot maps to client vs server
    var clientPort = Flow.client.port;
    var clientIs1 = (clientPort === Flow.port1);

    // If we never captured identity, do it now
    if (!id) {
        id = {
            ip_1: Flow.ipaddr1.toString(),
            port_1: Flow.port1,
            mac_1: Flow.device1.hwaddr,
            ip_2: Flow.ipaddr2.toString(),
            port_2: Flow.port2,
            mac_2: Flow.device2.hwaddr
        };
        Flow.store.identity = id;
    }

    // Map role-based termination booleans to positional _1 / _2
    var clientAborted = Flow.client.isAborted || false;
    var serverAborted = Flow.server.isAborted || false;
    var clientShutdown = Flow.client.isShutdown || false;
    var serverShutdown = Flow.server.isShutdown || false;

    var message = {
        version: VERSION,
        msg_type: "flow_close",
        ts: Date.now(),
        flow_id: Flow.id,
        flow_age: Flow.age,

        // Identity echo
        ip_1: id.ip_1,
        port_1: id.port_1,
        ip_2: id.ip_2,
        port_2: id.port_2,

        // Termination status (mapped to positional convention)
        // aborted: connection was RST'd (not graceful)
        aborted_1: clientIs1 ? clientAborted : serverAborted,
        aborted_2: clientIs1 ? serverAborted : clientAborted,

        // shutdown: this side initiated graceful close (sent FIN)
        shutdown_1: clientIs1 ? clientShutdown : serverShutdown,
        shutdown_2: clientIs1 ? serverShutdown : clientShutdown,

        // Expiry: flow timed out without proper termination
        expired: Flow.isExpired || false
    };
    //debug(JSON.stringify(message))
    Remote.Kafka(KAFKA_TARGET).send(KAFKA_TOPIC, JSON.stringify(message));
}



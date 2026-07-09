// ============================================================================
// Title:   TCP Flow Health Monitor
// Version: 4.0.0 (wire schema 3.3.0)
// Events:  TCP_OPEN, FLOW_TICK, SESSION_EXPIRE, TCP_CLOSE
//
// Purpose: Emit per-flow TCP health metrics via ODS for data warehouse
//          ingestion. Designed for durable peer-to-peer socket monitoring
//          (e.g. ISO 8583) where both endpoints use static ports.
//
// Design:  All metrics use the ExtraHop positional convention (_1 / _2).
//          Device 1 and Device 2 are assigned by the platform when the flow
//          is created and remain consistent for the flow's lifetime.
//
//          Endpoint role checks match the full (ip, port) tuple because
//          peer-to-peer flows may use the same port on both sides, making
//          port comparison alone ambiguous.
//
//          FLOW_TICK deltas are accumulated in the session table rather than
//          only in Flow.store. The session entry expires after the minimum
//          batching interval and is flushed on SESSION_EXPIRE if no later
//          flow event arrives. This prevents long-lived idle flows from
//          holding warehouse updates for minutes.
//
//          The session value snapshots all fields needed to emit later because
//          SESSION_EXPIRE is not associated with a flow and cannot access Flow
//          or TCP properties.
//
// Rate:    FLOW_TICK batches are emitted:
//            - on FLOW_TICK once at least MIN_BATCH_AGE_MS has elapsed,
//            - on SESSION_EXPIRE if a flow goes quiet,
//            - on TCP_CLOSE before flow_close, regardless of batch age,
//            - immediately for any late FLOW_TICK observed after TCP_CLOSE.
//
// Output:  JSON messages via ODS:
//            - flow_open:  Peer identity + TCP handshake parameters
//            - flow_tick:  Aggregated TCP health snapshot
//            - flow_close: Connection termination status
// ============================================================================

// ========================= Configuration ====================================
var KAFKA_TARGET     = "";         // ODS target name configured in ExtraHop admin
var KAFKA_TOPIC      = "";         // Kafka topic for flow health messages
var SCHEMA_VERSION   = "3.3.0";    // Wire schema version for warehouse
var MIN_BATCH_AGE_MS = 10000;      // Minimum ms between flow_tick emissions
var SESSION_EXPIRE_S = 10;         // Earliest idle-flow flush opportunity
var SESSION_KEY_PREFIX = "tcp_flow_health_v1:pending_tick:";

function sessionKey() {
    return SESSION_KEY_PREFIX + Flow.id;
}

function sessionOptions() {
    return {
        expire: SESSION_EXPIRE_S,
        notify: true,
        priority: Session.PRIORITY_HIGH
    };
}

function ipToString(ip) {
    return ip ? ip.toString() : null;
}

// Matches the full (ip, port) tuple. Port alone is ambiguous when both
// endpoints use the same static port.
function clientIs1() {
    return Flow.client.ipaddr.equals(Flow.ipaddr1) &&
           Flow.client.port === Flow.port1;
}

function storedSenderIs1() {
    var v = Flow.store.senderIs1;
    return v === undefined ? null : v;
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

function newAccum() {
    return {
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
}

function newPendingBatch(now) {
    return {
        first_ts: now,
        last_ts: now,
        flow_id: Flow.id,
        flow_age: Flow.age,
        ip_1: ipToString(Flow.ipaddr1),
        port_1: Flow.port1,
        ip_2: ipToString(Flow.ipaddr2),
        port_2: Flow.port2,
        sender_is_1: storedSenderIs1(),
        accum: newAccum()
    };
}

function mergeTick(batch, now) {
    var a = batch.accum;

    batch.last_ts = now;
    batch.flow_age = Flow.age;
    batch.sender_is_1 = storedSenderIs1();

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

    var rtt = Flow.roundTripTime;
    if (rtt !== null && !isNaN(rtt)) {
        a.rtt_ms = rtt;
    }

    a.dscp_1 = Flow.dscp1;
    a.dscp_2 = Flow.dscp2;
}

// ts is batch.last_ts so every flow_tick timestamp means the same thing:
// the time of the last merged data, regardless of which path emitted it.
function buildTickMessage(batch) {
    var a = batch.accum;
    return {
        version:  SCHEMA_VERSION,
        msg_type: "flow_tick",
        ts:       batch.last_ts,
        flow_id:  batch.flow_id,
        flow_age: batch.flow_age,

        ip_1:        batch.ip_1,
        port_1:      batch.port_1,
        ip_2:        batch.ip_2,
        port_2:      batch.port_2,
        sender_is_1: batch.sender_is_1,

        rtt_ms:             a.rtt_ms,
        retrans_bytes_1:    a.retrans_bytes_1,
        retrans_bytes_2:    a.retrans_bytes_2,
        rto_1:              a.rto_1,
        rto_2:              a.rto_2,
        zero_wnd_1:         a.zero_wnd_1,
        zero_wnd_2:         a.zero_wnd_2,
        rcv_wnd_throttle_1: a.rcv_wnd_throttle_1,
        rcv_wnd_throttle_2: a.rcv_wnd_throttle_2,
        nagle_delay_1:      a.nagle_delay_1,
        nagle_delay_2:      a.nagle_delay_2,
        l4_bytes_1:         a.l4_bytes_1,
        l4_bytes_2:         a.l4_bytes_2,
        pkts_1:             a.pkts_1,
        pkts_2:             a.pkts_2,
        l2_bytes_1:         a.l2_bytes_1,
        l2_bytes_2:         a.l2_bytes_2,
        dscp_1:             a.dscp_1,
        dscp_2:             a.dscp_2,
        frag_pkts_1:        a.frag_pkts_1,
        frag_pkts_2:        a.frag_pkts_2,
        overlap_segments_1: a.overlap_segments_1,
        overlap_segments_2: a.overlap_segments_2
    };
}

function sendKafkaMessages(messages) {
    if (!messages || messages.length === 0) { return; }
    Remote.Kafka(KAFKA_TARGET).send({
        topic: KAFKA_TOPIC,
        messages: messages
    });
}

function sendTickBatch(batch) {
    sendKafkaMessages([JSON.stringify(buildTickMessage(batch))]);
}

function handleFlowTick() {
    var now = Date.now();

    // Late post-close ticks carry final deltas. Keep them after flow_close by
    // bypassing the session buffer.
    if (Flow.store.closed) {
        var finalBatch = newPendingBatch(now);
        mergeTick(finalBatch, now);
        sendTickBatch(finalBatch);
        return;
    }

    var key = sessionKey();
    var batch = Session.lookup(key);

    if (!batch) {
        batch = newPendingBatch(now);
        Session.add(key, batch, sessionOptions());
    }

    mergeTick(batch, now);

    if ((now - batch.first_ts) >= MIN_BATCH_AGE_MS) {
        Session.remove(key);
        sendTickBatch(batch);
        return;
    }

    // Do not pass expire here. Preserving the original expiration keeps the
    // idle-flow backstop from sliding forward on every tick.
    Session.replace(key, batch);
}

function handleSessionExpire() {
    var keys = Session.expiredKeys;
    var messages = [];

    for (var i = 0; i < keys.length; i++) {
        var expired = keys[i];
        if (!expired || expired.name.indexOf(SESSION_KEY_PREFIX) !== 0) {
            continue;
        }

        var batch = expired.value;
        if (!batch || !batch.accum || !batch.flow_id) {
            continue;
        }

        messages.push(JSON.stringify(buildTickMessage(batch)));
    }

    sendKafkaMessages(messages);
}

// ========================= SESSION_EXPIRE ===================================
// Runs in approximately 30 second increments while the session table is in
// use. This event is the idle-flow flush path for pending FLOW_TICK batches.
// ============================================================================
if (event === "SESSION_EXPIRE") {
    handleSessionExpire();
    return;
}

// ========================= TCP_OPEN =========================================
// Fires when a TCP connection is first fully established. If the 3-way
// handshake was observed, handshake parameters and sender identification
// are available. For loose initiations, handshake-dependent values are null.
//
// TCP_OPEN runs AGAIN if a stalled connection resumes WITHIN the same flow
// (stall shorter than the flow expiry), with all handshake properties null.
// The openSent guard suppresses that duplicate and prevents clobbering a
// still-valid senderIs1 — the flow never closed, so positional assignment
// and sender identity are unchanged.
//
// This guard does NOT apply to a connection resuming after flow expiry:
// TCP_CLOSE already fired, the platform creates a new flow with a fresh
// Flow.store, and this block runs normally — emitting a new flow_open with
// sender_is_1 null (no 3WHS observed), signaling attribution is unknown.
// ============================================================================
if (event === "TCP_OPEN") {
    if (Flow.store.openSent) { return; }
    Flow.store.openSent = true;

    // Null on loose initiation (and resumed connections, guarded above).
    // Compare against null rather than 0: a fast LAN handshake can
    // legitimately round to 0 ms.
    var hsTime  = TCP.handshakeTime;
    var saw3whs = hsTime != null;

    // With an observed handshake, the client is the connection initiator.
    var senderIs1 = saw3whs ? clientIs1() : null;
    Flow.store.senderIs1 = senderIs1;

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
        ja4_1 = Flow.ja4TCPClient || null;
        ja4_2 = Flow.ja4TCPServer || null;
    }

    var openMessage = {
        version:  SCHEMA_VERSION,
        msg_type: "flow_open",
        ts:       Date.now(),
        flow_id:  Flow.id,

        ip_1:   ipToString(Flow.ipaddr1),
        port_1: Flow.port1,
        mac_1:  Flow.device1 ? Flow.device1.hwaddr : null,
        ip_2:   ipToString(Flow.ipaddr2),
        port_2: Flow.port2,
        mac_2:  Flow.device2 ? Flow.device2.hwaddr : null,

        sender_is_1: senderIs1,

        ip_proto:   Flow.ipproto,
        ip_version: Flow.ipver,
        vlan:       Flow.vlan || 0,

        handshake_ms:   hsTime,
        window_scale_1: ws_1,
        window_scale_2: ws_2,
        init_rcv_wnd_1: wnd_1,
        init_rcv_wnd_2: wnd_2,

        ja4t_1: ja4_1,
        ja4t_2: ja4_2
    };

    sendKafkaMessages([JSON.stringify(openMessage)]);
    return;
}

// ========================= FLOW_TICK ========================================
// Counter values from the platform are deltas since the last FLOW_TICK.
// RTT is the median observed since the last tick. We keep the last non-null
// value seen across the accumulation window.
// ============================================================================
if (event === "FLOW_TICK") {
    handleFlowTick();
    return;
}

// ========================= TCP_CLOSE ========================================
// Fires once when the TCP connection terminates. Any pending tick batch is
// drained before the close message so the warehouse sees metrics before
// lifecycle termination. Later FLOW_TICK events bypass the session buffer.
// ============================================================================
if (event === "TCP_CLOSE") {
    Flow.store.closed = true;

    var pending = Session.remove(sessionKey());
    if (pending) {
        sendTickBatch(pending);
    }

    var cIs1 = clientIs1();

    var clientShutdown = Flow.client.isShutdown || false;
    var serverShutdown = Flow.server.isShutdown || false;
    var clientReset    = TCP.client.isReset     || false;
    var serverReset    = TCP.server.isReset     || false;
    var clientAborted  = TCP.client.isAborted   || false;
    var serverAborted  = TCP.server.isAborted   || false;

    var closeMessage = {
        version:  SCHEMA_VERSION,
        msg_type: "flow_close",
        ts:       Date.now(),
        flow_id:  Flow.id,
        flow_age: Flow.age,

        ip_1:        ipToString(Flow.ipaddr1),
        port_1:      Flow.port1,
        ip_2:        ipToString(Flow.ipaddr2),
        port_2:      Flow.port2,
        sender_is_1: storedSenderIs1(),

        shutdown_1: cIs1 ? clientShutdown : serverShutdown,
        shutdown_2: cIs1 ? serverShutdown : clientShutdown,

        reset_1: cIs1 ? clientReset : serverReset,
        reset_2: cIs1 ? serverReset : clientReset,

        aborted_1: cIs1 ? clientAborted : serverAborted,
        aborted_2: cIs1 ? serverAborted : clientAborted,

        expired: Flow.isExpired || false
    };

    sendKafkaMessages([JSON.stringify(closeMessage)]);
}

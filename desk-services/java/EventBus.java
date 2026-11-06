// EventBus.java
//
// OpOne Capital Desk event bus (Phase 2, spec section 7).
// Dependency free, JDK standard library only. No Maven, no Gradle.
//
// What it does:
//   1. Reads JSON event lines from stdin.
//   2. Validates each line against the Desk event contract:
//      required fields type, id, ts, source, feed, payload.
//      type must be one of the event types in the spec.
//      graph_refs is optional; when absent it is added as [].
//   3. Appends valid events, one per line, to an events JSONL log file.
//   4. Serves the log over HTTP for the Desk:
//      GET /events    -> SSE stream of the event log, then live events
//      GET /health    -> {"status":"ok","accepted":N,"rejected":M}
//      GET /snapshot  -> latest quote.tick per symbol as JSON
//      POST /ingest   -> accept one bus event (Bearer token required)
//      GET /          -> short help text
//
// Host and port come from the environment, so the bus runs on Railway:
//   HOST env, default 127.0.0.1 (start.sh sets 0.0.0.0 on Railway)
//   PORT env, default 8899 (Railway provides PORT)
//   BUS_TOKEN env: when set, /ingest and /snapshot require
//     Authorization: Bearer <token>. When unset, /ingest stays disabled
//     and /snapshot is open. Never run this bus on a public port without
//     BUS_TOKEN set.
//
// Invalid lines are rejected, counted, and reported to stderr. They are
// never written to the log and never broadcast. No secrets are read, logged,
// or emitted. The server binds to HOST only. Nothing here calls the
// network except the local HTTP port.
//
// Build (JDK 11 or later):
//   javac EventBus.java
// Run:
//   java EventBus --port 8899 --log ../events.jsonl
//   (defaults: port 8899, log events.jsonl in the working directory)
// Pipe events in, for example:
//   cat events.sample.jsonl | java EventBus --port 8899 --log events.jsonl
// Post one event in, for example:
//   curl -X POST http://127.0.0.1:8899/ingest \
//     -H "Authorization: Bearer $BUS_TOKEN" -H "Content-Type: application/json" \
//     -d '{"type":"quote.tick","id":"x","ts":"...","source":"finnhub","feed":"finnhub","payload":{"symbol":"MU","price":690.00}}'
// Read the stream, for example:
//   curl -N http://127.0.0.1:8899/events
//   curl http://127.0.0.1:8899/health
//   curl http://127.0.0.1:8899/snapshot
//
// If the JDK refuses the built in HTTP server module, run with:
//   java --add-modules jdk.httpserver EventBus --port 8899 --log events.jsonl

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

public class EventBus {

    // Event types from spec section 7. A type outside this set is rejected.
    static final Set<String> TYPES = new HashSet<>(Arrays.asList(
        "quote.tick", "quote.level", "news.event", "trade.signal",
        "trade.placed", "trade.filled", "trade.trimmed", "trade.stopped",
        "alert.trigger", "brief.published", "graph.pattern", "graph.connector"
    ));

    static final AtomicLong accepted = new AtomicLong(0);
    static final AtomicLong rejected = new AtomicLong(0);
    static final List<BlockingQueue<String>> listeners = new CopyOnWriteArrayList<>();

    static volatile BufferedWriter logWriter;
    static volatile Path logPath;

    // Bearer token for /ingest and /snapshot. Empty means unset: /ingest
    // stays disabled and /snapshot is open. Set BUS_TOKEN on Railway.
    static volatile String busToken = "";

    // True when the request carries the right Bearer token. When no token
    // is configured, nothing is authorized (callers must check that first).
    static boolean authorized(HttpExchange ex) {
        if (busToken == null || busToken.isEmpty()) {
            return false;
        }
        String auth = ex.getRequestHeaders().getFirst("Authorization");
        if (auth == null || !auth.startsWith("Bearer ")) {
            return false;
        }
        String given = auth.substring("Bearer ".length()).trim();
        byte[] a = given.getBytes(StandardCharsets.UTF_8);
        byte[] b = busToken.getBytes(StandardCharsets.UTF_8);
        return java.security.MessageDigest.isEqual(a, b);
    }

    static void sendJson(HttpExchange ex, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    public static void main(String[] args) throws Exception {
        String host = System.getenv("HOST");
        if (host == null || host.isEmpty()) {
            host = "127.0.0.1";
        }
        int port = 8899;
        String portEnv = System.getenv("PORT");
        if (portEnv != null && !portEnv.isEmpty()) {
            port = Integer.parseInt(portEnv);
        }
        busToken = System.getenv("BUS_TOKEN");
        if (busToken == null) {
            busToken = "";
        }
        String logFile = "events.jsonl";
        for (int i = 0; i < args.length; i++) {
            if ("--port".equals(args[i]) && i + 1 < args.length) {
                port = Integer.parseInt(args[++i]);
            } else if ("--host".equals(args[i]) && i + 1 < args.length) {
                host = args[++i];
            } else if ("--log".equals(args[i]) && i + 1 < args.length) {
                logFile = args[++i];
            } else if ("--help".equals(args[i]) || "-h".equals(args[i])) {
                System.out.println("Usage: java EventBus [--host H] [--port N] [--log PATH]");
                System.out.println("Reads JSON event lines from stdin, validates them,");
                System.out.println("appends valid events to the log, serves them on HTTP.");
                System.out.println("Env: HOST (default 127.0.0.1), PORT (default 8899),");
                System.out.println("BUS_TOKEN (when set, /ingest and /snapshot need it).");
                return;
            } else {
                System.err.println("Unknown argument: " + args[i]);
                System.exit(2);
            }
        }
        logPath = Paths.get(logFile);
        if (logPath.getParent() != null) {
            Files.createDirectories(logPath.getParent());
        }
        // Count events already in the log so /health is honest after restart.
        if (Files.exists(logPath)) {
            long existing = Files.lines(logPath, StandardCharsets.UTF_8).count();
            accepted.set(existing);
        }
        logWriter = new BufferedWriter(new FileWriter(logPath.toFile(), true));

        HttpServer server = HttpServer.create(new InetSocketAddress(host, port), 0);
        server.createContext("/", EventBus::handleRoot);
        server.createContext("/health", EventBus::handleHealth);
        server.createContext("/events", EventBus::handleEvents);
        server.createContext("/ingest", EventBus::handleIngest);
        server.createContext("/snapshot", EventBus::handleSnapshot);
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();
        System.err.println("EventBus listening on " + host + ":" + port
            + " log=" + logPath.toAbsolutePath()
            + " ingest=" + (busToken.isEmpty() ? "disabled" : "token required"));

        // The main thread is the stdin reader. The HTTP server runs on its
        // own threads. When stdin closes, keep serving the log.
        BufferedReader in = new BufferedReader(
            new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            handleLine(line);
        }
        System.err.println("stdin closed. accepted=" + accepted.get()
            + " rejected=" + rejected.get() + ". Still serving the log.");
        new CountDownLatch(1).await();
    }

    // Validate one input line. Returns null on accept, else a short reason.
    // On success, appends to the log and broadcasts. Shared by the stdin
    // reader and POST /ingest, so both paths enforce the same contract.
    static String ingestLine(String line) {
        String trimmed = line.trim();
        if (trimmed.isEmpty()) {
            return "empty line";
        }
        Object parsed;
        try {
            parsed = Json.parse(trimmed);
        } catch (Json.ParseException e) {
            String reason = "not json: " + e.getMessage();
            reject(reason, trimmed);
            return reason;
        }
        if (!(parsed instanceof Map)) {
            reject("top level is not an object", trimmed);
            return "top level is not an object";
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> obj = (Map<String, Object>) parsed;
        String problem = validate(obj);
        if (problem != null) {
            reject(problem, trimmed);
            return problem;
        }
        if (!obj.containsKey("graph_refs")) {
            obj.put("graph_refs", new ArrayList<Object>());
        }
        String out = Json.stringify(obj);
        synchronized (EventBus.class) {
            try {
                logWriter.write(out);
                logWriter.newLine();
                logWriter.flush();
            } catch (IOException e) {
                System.err.println("ERROR writing log: " + e.getMessage());
                return "log write failed";
            }
        }
        accepted.incrementAndGet();
        broadcast(out);
        return null;
    }

    // stdin path: same validation, reason goes to stderr only.
    static void handleLine(String line) {
        ingestLine(line);
    }

    // Returns null when the event is valid, else a short reason.
    static String validate(Map<String, Object> obj) {
        Object type = obj.get("type");
        if (!(type instanceof String) || ((String) type).isEmpty()) {
            return "missing or empty type";
        }
        if (!TYPES.contains(type)) {
            return "unknown type: " + type;
        }
        for (String field : new String[]{"id", "ts", "source", "feed"}) {
            Object v = obj.get(field);
            if (!(v instanceof String) || ((String) v).isEmpty()) {
                return "missing or empty " + field;
            }
        }
        if (!obj.containsKey("payload")) {
            return "missing payload";
        }
        Object refs = obj.get("graph_refs");
        if (refs != null) {
            if (!(refs instanceof List)) {
                return "graph_refs is not an array";
            }
            for (Object r : (List<?>) refs) {
                if (!(r instanceof String)) {
                    return "graph_refs holds a non-string";
                }
            }
        }
        return null;
    }

    static void reject(String reason, String line) {
        rejected.incrementAndGet();
        String shown = line.length() > 200 ? line.substring(0, 200) + "..." : line;
        System.err.println("REJECT (" + reason + "): " + shown);
    }

    static void broadcast(String line) {
        for (BlockingQueue<String> q : listeners) {
            q.offer(line);
        }
    }

    static void handleRoot(HttpExchange ex) throws IOException {
        String body = "OpOne Capital Desk event bus.\n"
            + "GET /events    - SSE stream of the event log, then live events.\n"
            + "GET /health    - JSON status with accepted and rejected counts.\n"
            + "GET /snapshot  - latest quote.tick per symbol as JSON.\n"
            + "POST /ingest   - accept one bus event (Bearer token required).\n";
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "text/plain; charset=utf-8");
        ex.sendResponseHeaders(200, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    // POST /ingest: accept one bus event as JSON. Disabled entirely when
    // no BUS_TOKEN is configured. Otherwise the Authorization Bearer token
    // must match. The event goes through the same validation as stdin.
    static void handleIngest(HttpExchange ex) throws IOException {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }
        if (busToken == null || busToken.isEmpty()) {
            sendJson(ex, 404, "{\"error\":\"ingest disabled\"}");
            return;
        }
        if (!authorized(ex)) {
            sendJson(ex, 401, "{\"error\":\"unauthorized\"}");
            return;
        }
        byte[] bodyBytes = ex.getRequestBody().readAllBytes();
        if (bodyBytes.length > 65536) {
            sendJson(ex, 400, "{\"error\":\"event too large\"}");
            return;
        }
        String line = new String(bodyBytes, StandardCharsets.UTF_8);
        String problem = ingestLine(line);
        if (problem != null) {
            sendJson(ex, 400, "{\"status\":\"rejected\",\"reason\":"
                + Json.stringify(problem) + "}");
            return;
        }
        sendJson(ex, 200, "{\"status\":\"accepted\"}");
    }

    // GET /snapshot: latest quote.tick per symbol, from the log, as JSON.
    // Requires the Bearer token whenever BUS_TOKEN is set.
    static void handleSnapshot(HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }
        if (busToken != null && !busToken.isEmpty() && !authorized(ex)) {
            sendJson(ex, 401, "{\"error\":\"unauthorized\"}");
            return;
        }
        Map<String, Object> ticks = new LinkedHashMap<>();
        if (Files.exists(logPath)) {
            for (String logged : Files.readAllLines(logPath, StandardCharsets.UTF_8)) {
                Object parsed;
                try {
                    parsed = Json.parse(logged.trim());
                } catch (Json.ParseException ignored) {
                    continue; // a torn log line never matches
                }
                if (!(parsed instanceof Map)) {
                    continue;
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> obj = (Map<String, Object>) parsed;
                if (!"quote.tick".equals(obj.get("type"))) {
                    continue;
                }
                Object payload = obj.get("payload");
                if (!(payload instanceof Map)) {
                    continue;
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> p = (Map<String, Object>) payload;
                Object sym = p.get("symbol");
                Object price = p.get("price");
                if (!(sym instanceof String) || !(price instanceof Json.Num)) {
                    continue;
                }
                Map<String, Object> tick = new LinkedHashMap<>();
                tick.put("price", price);
                if (p.get("volume") instanceof Json.Num) {
                    tick.put("volume", p.get("volume"));
                }
                if (obj.get("ts") instanceof String) {
                    tick.put("ts", obj.get("ts"));
                }
                if (obj.get("id") instanceof String) {
                    tick.put("id", obj.get("id"));
                }
                // Log order is append order, so the last one wins.
                ticks.put((String) sym, tick);
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", "ok");
        out.put("accepted", new Json.Num(Long.toString(accepted.get())));
        out.put("rejected", new Json.Num(Long.toString(rejected.get())));
        out.put("ticks", ticks);
        sendJson(ex, 200, Json.stringify(out));
    }

    static void handleHealth(HttpExchange ex) throws IOException {
        String body = "{\"status\":\"ok\",\"accepted\":" + accepted.get()
            + ",\"rejected\":" + rejected.get() + "}";
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.sendResponseHeaders(200, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    static void handleEvents(HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }
        String after = null;
        String query = ex.getRequestURI().getRawQuery();
        if (query != null) {
            for (String pair : query.split("&")) {
                int eq = pair.indexOf('=');
                if (eq > 0 && "after".equals(pair.substring(0, eq))) {
                    after = java.net.URLDecoder.decode(
                        pair.substring(eq + 1), StandardCharsets.UTF_8.name());
                }
            }
        }
        ex.getResponseHeaders().set("Content-Type", "text/event-stream");
        ex.getResponseHeaders().set("Cache-Control", "no-cache");
        ex.getResponseHeaders().set("Connection", "keep-alive");
        ex.sendResponseHeaders(200, 0);
        OutputStream os = ex.getResponseBody();
        BufferedWriter out = new BufferedWriter(
            new OutputStreamWriter(os, StandardCharsets.UTF_8));
        BlockingQueue<String> queue = new LinkedBlockingQueue<>();
        listeners.add(queue);
        try {
            // Replay the log first, so a late subscriber sees the day so far.
            boolean skipping = after != null;
            if (Files.exists(logPath)) {
                for (String logged : Files.readAllLines(logPath, StandardCharsets.UTF_8)) {
                    if (skipping) {
                        if (lineHasId(logged, after)) {
                            skipping = false;
                        }
                        continue;
                    }
                    out.write("data: " + logged + "\n\n");
                }
                out.flush();
            }
            // Then stream live events until the client goes away.
            while (true) {
                String line = queue.poll(15, TimeUnit.SECONDS);
                if (line == null) {
                    out.write(": ping\n\n");
                    out.flush();
                } else {
                    out.write("data: " + line + "\n\n");
                    out.flush();
                }
            }
        } catch (IOException | InterruptedException e) {
            // Client disconnected. Normal for SSE.
        } finally {
            listeners.remove(queue);
            try { out.close(); } catch (IOException ignored) { }
        }
    }

    // True when the logged JSON line carries the given id.
    static boolean lineHasId(String logged, String id) {
        try {
            Object parsed = Json.parse(logged);
            if (parsed instanceof Map) {
                Object v = ((Map<?, ?>) parsed).get("id");
                return id.equals(v);
            }
        } catch (Json.ParseException ignored) {
            // A corrupt log line never matches.
        }
        return false;
    }

    // Minimal JSON parser and serializer. Standard library only.
    // Numbers keep their raw literal so prices survive round trips exactly.
    static final class Json {

        static final class ParseException extends Exception {
            ParseException(String m) { super(m); }
        }

        // Raw number literal, kept verbatim.
        static final class Num {
            final String raw;
            Num(String raw) { this.raw = raw; }
        }

        static Object parse(String s) throws ParseException {
            Parser p = new Parser(s);
            Object v = p.value();
            p.ws();
            if (p.i != s.length()) {
                throw new ParseException("trailing data at " + p.i);
            }
            return v;
        }

        static String stringify(Object v) {
            StringBuilder sb = new StringBuilder();
            write(v, sb);
            return sb.toString();
        }

        @SuppressWarnings("unchecked")
        static void write(Object v, StringBuilder sb) {
            if (v == null) {
                sb.append("null");
            } else if (v instanceof String) {
                sb.append('"').append(escape((String) v)).append('"');
            } else if (v instanceof Num) {
                sb.append(((Num) v).raw);
            } else if (v instanceof Boolean) {
                sb.append(v.toString());
            } else if (v instanceof List) {
                sb.append('[');
                boolean first = true;
                for (Object e : (List<Object>) v) {
                    if (!first) sb.append(',');
                    first = false;
                    write(e, sb);
                }
                sb.append(']');
            } else if (v instanceof Map) {
                sb.append('{');
                boolean first = true;
                for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) {
                    if (!first) sb.append(',');
                    first = false;
                    sb.append('"').append(escape(e.getKey())).append('"').append(':');
                    write(e.getValue(), sb);
                }
                sb.append('}');
            } else {
                throw new IllegalArgumentException("unserializable: " + v.getClass());
            }
        }

        static String escape(String s) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"': sb.append("\\\""); break;
                    case '\\': sb.append("\\\\"); break;
                    case '\b': sb.append("\\b"); break;
                    case '\f': sb.append("\\f"); break;
                    case '\n': sb.append("\\n"); break;
                    case '\r': sb.append("\\r"); break;
                    case '\t': sb.append("\\t"); break;
                    default:
                        if (c < 0x20) {
                            sb.append(String.format("\\u%04x", (int) c));
                        } else {
                            sb.append(c);
                        }
                }
            }
            return sb.toString();
        }

        static final class Parser {
            final String s;
            int i = 0;

            Parser(String s) { this.s = s; }

            void ws() {
                while (i < s.length()) {
                    char c = s.charAt(i);
                    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++;
                    else break;
                }
            }

            Object value() throws ParseException {
                ws();
                if (i >= s.length()) throw new ParseException("unexpected end");
                char c = s.charAt(i);
                if (c == '{') return object();
                if (c == '[') return array();
                if (c == '"') return string();
                if (c == 't') { literal("true"); return Boolean.TRUE; }
                if (c == 'f') { literal("false"); return Boolean.FALSE; }
                if (c == 'n') { literal("null"); return null; }
                if (c == '-' || (c >= '0' && c <= '9')) return number();
                throw new ParseException("unexpected char '" + c + "' at " + i);
            }

            void literal(String word) throws ParseException {
                if (!s.startsWith(word, i)) {
                    throw new ParseException("bad literal at " + i);
                }
                i += word.length();
            }

            Map<String, Object> object() throws ParseException {
                Map<String, Object> m = new LinkedHashMap<>();
                i++; // {
                ws();
                if (i < s.length() && s.charAt(i) == '}') { i++; return m; }
                while (true) {
                    ws();
                    if (i >= s.length() || s.charAt(i) != '"') {
                        throw new ParseException("expected string key at " + i);
                    }
                    String key = string();
                    ws();
                    if (i >= s.length() || s.charAt(i) != ':') {
                        throw new ParseException("expected ':' at " + i);
                    }
                    i++;
                    m.put(key, value());
                    ws();
                    if (i >= s.length()) throw new ParseException("unterminated object");
                    char c = s.charAt(i);
                    if (c == ',') { i++; continue; }
                    if (c == '}') { i++; return m; }
                    throw new ParseException("expected ',' or '}' at " + i);
                }
            }

            List<Object> array() throws ParseException {
                List<Object> list = new ArrayList<>();
                i++; // [
                ws();
                if (i < s.length() && s.charAt(i) == ']') { i++; return list; }
                while (true) {
                    list.add(value());
                    ws();
                    if (i >= s.length()) throw new ParseException("unterminated array");
                    char c = s.charAt(i);
                    if (c == ',') { i++; continue; }
                    if (c == ']') { i++; return list; }
                    throw new ParseException("expected ',' or ']' at " + i);
                }
            }

            String string() throws ParseException {
                i++; // opening quote
                StringBuilder sb = new StringBuilder();
                while (i < s.length()) {
                    char c = s.charAt(i++);
                    if (c == '"') return sb.toString();
                    if (c == '\\') {
                        if (i >= s.length()) break;
                        char e = s.charAt(i++);
                        switch (e) {
                            case '"': sb.append('"'); break;
                            case '\\': sb.append('\\'); break;
                            case '/': sb.append('/'); break;
                            case 'b': sb.append('\b'); break;
                            case 'f': sb.append('\f'); break;
                            case 'n': sb.append('\n'); break;
                            case 'r': sb.append('\r'); break;
                            case 't': sb.append('\t'); break;
                            case 'u':
                                if (i + 4 > s.length()) {
                                    throw new ParseException("bad unicode escape");
                                }
                                int code = Integer.parseInt(s.substring(i, i + 4), 16);
                                i += 4;
                                sb.append((char) code);
                                break;
                            default:
                                throw new ParseException("bad escape \\" + e);
                        }
                    } else {
                        sb.append(c);
                    }
                }
                throw new ParseException("unterminated string");
            }

            Num number() throws ParseException {
                int start = i;
                if (i < s.length() && s.charAt(i) == '-') i++;
                while (i < s.length() && Character.isDigit(s.charAt(i))) i++;
                if (i < s.length() && s.charAt(i) == '.') {
                    i++;
                    while (i < s.length() && Character.isDigit(s.charAt(i))) i++;
                }
                if (i < s.length() && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
                    i++;
                    if (i < s.length() && (s.charAt(i) == '+' || s.charAt(i) == '-')) i++;
                    while (i < s.length() && Character.isDigit(s.charAt(i))) i++;
                }
                if (i == start) throw new ParseException("bad number at " + start);
                return new Num(s.substring(start, i));
            }
        }
    }
}

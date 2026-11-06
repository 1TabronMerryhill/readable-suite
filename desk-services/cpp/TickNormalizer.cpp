// TickNormalizer.cpp
//
// OpOne Capital Desk tick normalizer (Phase 2, spec section 7).
// Standard library only. No external JSON library.
//
// What it does:
//   Reads Finnhub trade JSON lines from stdin and emits Desk quote.tick
//   JSON lines to stdout, one per trade, in the event contract shape:
//     {"type":"quote.tick","id":"...","ts":"...","source":"finnhub",
//      "feed":"finnhub","payload":{"symbol":"MU","price":691.73,
//      "volume":10},"graph_refs":[]}
//
// Input shape (raw Finnhub websocket trade message):
//   {"type":"trade","data":[{"s":"MU","p":691.73,"v":10,"t":1793990400000}]}
//   s is the symbol, p the price, v the volume, t the epoch millis time.
//   v and t are optional. When t is missing, receipt time is used.
//   When t looks like seconds instead of millis, it is scaled up.
//
// Lines that already carry type quote.tick and the required contract
// fields are passed through unchanged. Anything else is skipped with a
// note on stderr. Malformed lines are skipped, counted, and never crash
// the program. No secrets are read, logged, or emitted. No network.
//
// Build:
//   g++ -std=c++17 -O2 -Wall -Wextra -o tick-normalizer TickNormalizer.cpp
// Run:
//   ./tick-normalizer < trades.jsonl > ticks.jsonl
// Full pipeline (see ../README.md):
//   python3 finnhub_ws.py MU QCOM GLD | ./tick-normalizer | java EventBus
//
// At end of input, a one line summary goes to stderr:
//   normalized N ticks from M trade messages, passed through P, skipped K.

#include <chrono>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

// ---------- Minimal JSON value and parser (known shapes only) ----------

struct Json {
    enum Kind { Null, Bool, Num, Str, Arr, Obj } kind = Null;
    bool boolean = false;
    std::string num;   // raw number literal, kept verbatim
    std::string str;
    std::vector<Json> arr;
    std::vector<std::pair<std::string, Json>> obj;

    const Json* find(const std::string& key) const {
        if (kind != Obj) return nullptr;
        for (const auto& kv : obj) {
            if (kv.first == key) return &kv.second;
        }
        return nullptr;
    }
    bool isString() const { return kind == Str; }
    bool isNum() const { return kind == Num; }
};

class JsonParser {
public:
    explicit JsonParser(const std::string& text) : s_(text), i_(0) {}

    Json parse() {
        Json v = value();
        ws();
        if (i_ != s_.size()) fail("trailing data");
        return v;
    }

private:
    const std::string& s_;
    size_t i_;

    [[noreturn]] void fail(const std::string& msg) const {
        throw std::runtime_error(msg + " at offset " + std::to_string(i_));
    }
    void ws() {
        while (i_ < s_.size() && (s_[i_] == ' ' || s_[i_] == '\t' ||
               s_[i_] == '\n' || s_[i_] == '\r')) ++i_;
    }
    char peek() const { return i_ < s_.size() ? s_[i_] : '\0'; }

    Json value() {
        ws();
        if (i_ >= s_.size()) fail("unexpected end");
        char c = s_[i_];
        if (c == '{') return object();
        if (c == '[') return array();
        if (c == '"') { Json v; v.kind = Json::Str; v.str = string(); return v; }
        if (c == 't') { literal("true"); Json v; v.kind = Json::Bool; v.boolean = true; return v; }
        if (c == 'f') { literal("false"); Json v; v.kind = Json::Bool; v.boolean = false; return v; }
        if (c == 'n') { literal("null"); return Json(); }
        if (c == '-' || (c >= '0' && c <= '9')) return number();
        fail(std::string("unexpected char '") + c + "'");
    }
    void literal(const char* word) {
        size_t n = std::strlen(word);
        if (s_.compare(i_, n, word) != 0) fail("bad literal");
        i_ += n;
    }
    Json object() {
        Json v; v.kind = Json::Obj;
        ++i_; // {
        ws();
        if (peek() == '}') { ++i_; return v; }
        while (true) {
            ws();
            if (peek() != '"') fail("expected string key");
            std::string key = string();
            ws();
            if (peek() != ':') fail("expected ':'");
            ++i_;
            v.obj.push_back({key, value()});
            ws();
            if (i_ >= s_.size()) fail("unterminated object");
            if (s_[i_] == ',') { ++i_; continue; }
            if (s_[i_] == '}') { ++i_; return v; }
            fail("expected ',' or '}'");
        }
    }
    Json array() {
        Json v; v.kind = Json::Arr;
        ++i_; // [
        ws();
        if (peek() == ']') { ++i_; return v; }
        while (true) {
            v.arr.push_back(value());
            ws();
            if (i_ >= s_.size()) fail("unterminated array");
            if (s_[i_] == ',') { ++i_; continue; }
            if (s_[i_] == ']') { ++i_; return v; }
            fail("expected ',' or ']'");
        }
    }
    static void appendUtf8(std::string& out, unsigned cp) {
        if (cp < 0x80) {
            out.push_back(static_cast<char>(cp));
        } else if (cp < 0x800) {
            out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else if (cp < 0x10000) {
            out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else {
            out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
    }
    std::string string() {
        ++i_; // opening quote
        std::string out;
        while (i_ < s_.size()) {
            char c = s_[i_++];
            if (c == '"') return out;
            if (c == '\\') {
                if (i_ >= s_.size()) break;
                char e = s_[i_++];
                switch (e) {
                    case '"': out.push_back('"'); break;
                    case '\\': out.push_back('\\'); break;
                    case '/': out.push_back('/'); break;
                    case 'b': out.push_back('\b'); break;
                    case 'f': out.push_back('\f'); break;
                    case 'n': out.push_back('\n'); break;
                    case 'r': out.push_back('\r'); break;
                    case 't': out.push_back('\t'); break;
                    case 'u': {
                        if (i_ + 4 > s_.size()) fail("bad unicode escape");
                        unsigned cp = 0;
                        for (int k = 0; k < 4; ++k) {
                            char h = s_[i_++];
                            cp <<= 4;
                            if (h >= '0' && h <= '9') cp |= (h - '0');
                            else if (h >= 'a' && h <= 'f') cp |= (h - 'a' + 10);
                            else if (h >= 'A' && h <= 'F') cp |= (h - 'A' + 10);
                            else fail("bad hex in unicode escape");
                        }
                        appendUtf8(out, cp);
                        break;
                    }
                    default: fail(std::string("bad escape \\") + e);
                }
            } else {
                out.push_back(c);
            }
        }
        fail("unterminated string");
    }
    Json number() {
        size_t start = i_;
        if (peek() == '-') ++i_;
        while (i_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[i_]))) ++i_;
        if (peek() == '.') {
            ++i_;
            while (i_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[i_]))) ++i_;
        }
        if (peek() == 'e' || peek() == 'E') {
            ++i_;
            if (peek() == '+' || peek() == '-') ++i_;
            while (i_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[i_]))) ++i_;
        }
        if (i_ == start) fail("bad number");
        Json v; v.kind = Json::Num; v.num = s_.substr(start, i_ - start);
        return v;
    }
};

// ---------- Helpers ----------

std::string jsonEscape(const std::string& s) {
    std::string out;
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof buf, "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back(c);
                }
        }
    }
    return out;
}

// Epoch millis to ISO-8601 UTC with millis, e.g. 2026-11-06T19:26:40.000Z.
std::string isoMillis(long long ms) {
    long long sec = ms / 1000;
    int milli = static_cast<int>(ms % 1000);
    if (milli < 0) { milli += 1000; sec -= 1; }
    std::time_t t = static_cast<std::time_t>(sec);
    std::tm tmv;
    gmtime_r(&t, &tmv);
    char buf[64];
    std::snprintf(buf, sizeof buf, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                  tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
                  tmv.tm_hour, tmv.tm_min, tmv.tm_sec, milli);
    return std::string(buf);
}

long long nowMillis() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

bool parseLong(const std::string& raw, long long& out) {
    try {
        size_t used = 0;
        out = std::stoll(raw, &used);
        return used == raw.size();
    } catch (...) {
        return false;
    }
}

// ---------- Main ----------

int main() {
    long long tradeMessages = 0;
    long long ticks = 0;
    long long passedThrough = 0;
    long long skipped = 0;
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        Json root;
        try {
            root = JsonParser(line).parse();
        } catch (const std::exception& e) {
            ++skipped;
            std::cerr << "skip (not json: " << e.what() << "): "
                      << line.substr(0, 120) << "\n";
            continue;
        }
        if (root.kind != Json::Obj) {
            ++skipped;
            std::cerr << "skip (top level is not an object)\n";
            continue;
        }
        const Json* type = root.find("type");
        if (type == nullptr || !type->isString()) {
            ++skipped;
            std::cerr << "skip (no string type field)\n";
            continue;
        }
        if (type->str == "trade") {
            const Json* data = root.find("data");
            if (data == nullptr || data->kind != Json::Arr) {
                ++skipped;
                std::cerr << "skip (trade message without data array)\n";
                continue;
            }
            ++tradeMessages;
            int index = 0;
            for (const Json& trade : data->arr) {
                const Json* s = trade.find("s");
                const Json* p = trade.find("p");
                if (s == nullptr || !s->isString() || s->str.empty() ||
                    p == nullptr || !p->isNum()) {
                    ++skipped;
                    std::cerr << "skip (trade without symbol or price)\n";
                    continue;
                }
                const Json* v = trade.find("v");
                const Json* t = trade.find("t");
                long long tms = 0;
                bool haveTime = false;
                if (t != nullptr && t->isNum()) {
                    long long raw = 0;
                    if (parseLong(t->num, raw)) {
                        // Finnhub sends millis. A seconds value is scaled up.
                        tms = (raw < 100000000000LL) ? raw * 1000 : raw;
                        haveTime = true;
                    }
                }
                if (!haveTime) tms = nowMillis();
                std::string id = "finnhub-" + s->str + "-" + std::to_string(tms)
                    + "-" + std::to_string(index);
                std::string ts = isoMillis(tms);
                std::cout << "{\"type\":\"quote.tick\",\"id\":\"" << jsonEscape(id)
                          << "\",\"ts\":\"" << ts
                          << "\",\"source\":\"finnhub\",\"feed\":\"finnhub\",\"payload\":"
                          << "{\"symbol\":\"" << jsonEscape(s->str)
                          << "\",\"price\":" << p->num;
                if (v != nullptr && v->isNum()) {
                    std::cout << ",\"volume\":" << v->num;
                }
                std::cout << "},\"graph_refs\":[]}\n";
                ++ticks;
                ++index;
            }
            continue;
        }
        if (type->str == "quote.tick") {
            // Already in contract shape. Pass through when the required
            // fields are present; otherwise skip it like any bad line.
            bool ok = true;
            for (const char* f : {"id", "ts", "source", "feed", "payload"}) {
                if (root.find(f) == nullptr) ok = false;
            }
            if (ok) {
                std::cout << line << "\n";
                ++passedThrough;
            } else {
                ++skipped;
                std::cerr << "skip (quote.tick missing required fields)\n";
            }
            continue;
        }
        ++skipped;
        std::cerr << "skip (unhandled type: " << type->str << ")\n";
    }
    std::cerr << "normalized " << ticks << " ticks from " << tradeMessages
              << " trade messages, passed through " << passedThrough
              << ", skipped " << skipped << "\n";
    return 0;
}

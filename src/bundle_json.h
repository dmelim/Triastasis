#pragma once
// Bounded JSON reader for the small native container manifests. It accepts
// standard JSON, rejects duplicate keys and never treats text as file paths.
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace trellis::bundle_json {
struct Value {
    enum Kind { Null, Boolean, Number, String, Array, Object } kind = Null;
    bool boolean = false;
    double number = 0;
    std::string string;
    std::vector<Value> array;
    std::map<std::string, Value> object;
    const Value& at(const std::string& key) const {
        auto it = object.find(key);
        if (kind != Object || it == object.end()) throw std::runtime_error("missing manifest field: " + key);
        return it->second;
    }
    const std::string& text() const { if (kind != String) throw std::runtime_error("expected manifest string"); return string; }
    uint64_t integer() const {
        if (kind != Number || number < 0 || number > 9007199254740991.0 || std::floor(number) != number)
            throw std::runtime_error("expected exact manifest integer");
        return uint64_t(number);
    }
    bool flag() const { if (kind != Boolean) throw std::runtime_error("expected manifest boolean"); return boolean; }
};
class Parser {
    const std::string& input_;
    size_t cursor_ = 0, nodes_ = 0;
    [[noreturn]] void invalid() const { throw std::runtime_error("invalid container JSON"); }
    void space() { while (cursor_ < input_.size() && (input_[cursor_] == ' ' || input_[cursor_] == '\t' || input_[cursor_] == '\n' || input_[cursor_] == '\r')) cursor_++; }
    bool eat(char c) { space(); if (cursor_ < input_.size() && input_[cursor_] == c) { cursor_++; return true; } return false; }
    void literal(const char* text) { for (; *text; ++text) if (cursor_ >= input_.size() || input_[cursor_++] != *text) invalid(); }
    unsigned hex4() {
        unsigned result = 0;
        for (int i = 0; i < 4; ++i) {
            if (cursor_ >= input_.size()) invalid();
            char c = input_[cursor_++]; unsigned n;
            if (c >= '0' && c <= '9') n = unsigned(c - '0');
            else if (c >= 'a' && c <= 'f') n = unsigned(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') n = unsigned(c - 'A' + 10);
            else invalid();
            result = result * 16 + n;
        }
        return result;
    }
    void utf8(std::string& out, unsigned cp) {
        if (cp <= 0x7f) out += char(cp);
        else if (cp <= 0x7ff) { out += char(0xc0 | (cp >> 6)); out += char(0x80 | (cp & 63)); }
        else if (cp <= 0xffff) { out += char(0xe0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 63)); out += char(0x80 | (cp & 63)); }
        else { out += char(0xf0 | (cp >> 18)); out += char(0x80 | ((cp >> 12) & 63)); out += char(0x80 | ((cp >> 6) & 63)); out += char(0x80 | (cp & 63)); }
    }
    std::string text() {
        if (!eat('"')) invalid();
        std::string out;
        while (cursor_ < input_.size()) {
            unsigned char c = input_[cursor_++];
            if (c == '"') return out;
            if (c < 32) invalid();
            if (c != '\\') { out += char(c); continue; }
            if (cursor_ == input_.size()) invalid();
            switch (input_[cursor_++]) {
                case '"': out += '"'; break; case '\\': out += '\\'; break; case '/': out += '/'; break;
                case 'b': out += '\b'; break; case 'f': out += '\f'; break; case 'n': out += '\n'; break;
                case 'r': out += '\r'; break; case 't': out += '\t'; break;
                case 'u': {
                    unsigned cp = hex4();
                    if (cp >= 0xd800 && cp <= 0xdbff) {
                        literal("\\u"); unsigned low = hex4();
                        if (low < 0xdc00 || low > 0xdfff) invalid();
                        cp = 0x10000 + ((cp - 0xd800) << 10) + low - 0xdc00;
                    } else if (cp >= 0xdc00 && cp <= 0xdfff) invalid();
                    utf8(out, cp); break;
                }
                default: invalid();
            }
        }
        invalid();
    }
    Value value(unsigned depth) {
        if (depth > 32 || ++nodes_ > 32768) invalid();
        space(); if (cursor_ == input_.size()) invalid();
        Value out; char c = input_[cursor_];
        if (c == '{') {
            cursor_++; out.kind = Value::Object;
            if (eat('}')) return out;
            do {
                auto key = text(); if (!eat(':')) invalid();
                auto item = value(depth + 1);
                if (!out.object.emplace(std::move(key), std::move(item)).second) invalid();
                if (eat('}')) return out;
            } while (eat(','));
            invalid();
        }
        if (c == '[') {
            cursor_++; out.kind = Value::Array;
            if (eat(']')) return out;
            do { out.array.push_back(value(depth + 1)); if (eat(']')) return out; } while (eat(','));
            invalid();
        }
        if (c == '"') { out.kind = Value::String; out.string = text(); return out; }
        if (c == 't' || c == 'f') { out.kind = Value::Boolean; out.boolean = c == 't'; literal(c == 't' ? "true" : "false"); return out; }
        if (c == 'n') { literal("null"); return out; }
        size_t start = cursor_;
        if (input_[cursor_] == '-') cursor_++;
        if (cursor_ == input_.size()) invalid();
        if (input_[cursor_] == '0') cursor_++;
        else {
            if (input_[cursor_] < '1' || input_[cursor_] > '9') invalid();
            while (cursor_ < input_.size() && input_[cursor_] >= '0' && input_[cursor_] <= '9') cursor_++;
        }
        for (char marker : {'.', 'e'}) {
            if (cursor_ == input_.size() || (input_[cursor_] != marker && !(marker == 'e' && input_[cursor_] == 'E'))) continue;
            cursor_++;
            if (marker == 'e' && cursor_ < input_.size() && (input_[cursor_] == '+' || input_[cursor_] == '-')) cursor_++;
            size_t digits = cursor_;
            while (cursor_ < input_.size() && input_[cursor_] >= '0' && input_[cursor_] <= '9') cursor_++;
            if (digits == cursor_) invalid();
        }
        std::string token = input_.substr(start, cursor_ - start);
        char* end = nullptr; out.number = std::strtod(token.c_str(), &end);
        if (end != token.c_str() + token.size() || !std::isfinite(out.number)) invalid();
        out.kind = Value::Number; return out;
    }
public:
    explicit Parser(const std::string& input) : input_(input) {}
    Value parse() { auto out = value(0); space(); if (cursor_ != input_.size()) invalid(); return out; }
};
}  // namespace trellis::bundle_json

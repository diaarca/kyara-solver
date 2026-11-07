#pragma once

#include <array>
#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <nlohmann/json.hpp>

namespace rebirth {
using Json = nlohmann::json;
using Cards = std::map<std::string, Json>;
inline const std::array<std::string, 6> rarities = {"C", "U", "R", "E", "L", "M"};

struct Requirement { int64_t current = 0, target = 0, remaining = 0; };
struct State {
  std::array<Requirement, 6> requirements;
  std::set<std::string> owned;
  std::string collected_at;
  int64_t next_rebirth = 0;
  size_t unfinished = 0;
  Json summary;
};
struct Progress { double score = 0; Json by_rarity = Json::object(); };

State load(const Json& input, const Cards& cards, const std::set<std::string>& owned);
double occurrence(double probability, int64_t horizon);
Progress evaluate(const Json& booster, const Cards& cards, const State& state, int64_t horizon = 1);
}  // namespace rebirth

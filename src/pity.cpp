#include "pity.h"
#include <cmath>
#include <map>
#include <stdexcept>

namespace pity {
namespace {
using Json = nlohmann::json;
void check(bool ok, const std::string &message) {
  if (!ok)
    throw std::runtime_error(message);
}
Json moments(const Json &slots) {
  struct Moments { double expected = 0, absent = 1; };
  std::map<std::string, Moments> values;
  for (const auto &slot : slots) {
    for (const auto &[id, value] : slot.at("probabilities").items()) {
      const double p = value.get<double>();
      const auto draws = slot.at("draws").get<int64_t>();
      auto &m = values[id];
      m.expected += draws * p;
      m.absent *= std::pow(1 - p, draws);
    }
  }
  Json outcomes = Json::array();
  for (const auto &[id, value] : values)
    if (value.expected > 0)
      outcomes.push_back({{"card_id", id}, {"expected_copies", value.expected},
                          {"occurrence_probability", 1 - value.absent}});
  return outcomes;
}
} // namespace

Json batch(const Json &booster, const rebirth::Cards &cards, int64_t horizon) {
  const auto verification = booster.value("verification", Json(nullptr));
  check(verification.is_object() && verification.contains("model"), "Guaranteed Mythic requires an independent-slot model");
  const auto &model = verification.at("model");
  check(model.value("type", "") == "independent_slots" && model.at("slots").is_array() && !model["slots"].empty(),
        "Guaranteed Mythic requires an independent-slot model");
  auto slots = model["slots"];
  int64_t total = 0;
  for (const auto &slot : slots) {
    check(slot.at("draws").is_number_integer(), "Invalid slot draws");
    const auto draws = slot["draws"].get<int64_t>();
    check(draws > 0 && draws <= 10000 && (total += draws) <= 100000, "Invalid or excessive slot draws");
    check(slot.at("probabilities").is_object(), "Invalid slot distribution");
    double sum = 0;
    for (const auto &[id, value] : slot["probabilities"].items()) {
      check(cards.contains(id) && value.is_number(), "Unknown slot card or invalid probability");
      const double p = value.get<double>();
      check(std::isfinite(p) && p >= 0 && p <= 1, "Invalid slot probability");
      sum += p;
    }
    check(std::abs(sum - 1) < 1e-9, "Slot probabilities must sum to one");
  }
  const auto baseline = moments(slots);
  std::map<std::string, Json> stored;
  for (const auto &o : booster.at("outcomes")) {
    const auto id = o.at("card_id").is_string() ? o["card_id"].get<std::string>() : o["card_id"].dump();
    check(stored.emplace(id, o).second, "Duplicate card outcome");
  }
  check(stored.size() == baseline.size(), "Stored outcomes disagree with probability model");
  Json mythics = Json::object();
  for (const auto &o : baseline) {
    const auto id = o["card_id"].get<std::string>();
    check(stored.contains(id)
          && std::abs(stored.at(id).at("expected_copies").get<double>() - o["expected_copies"].get<double>()) < 1e-9
          && std::abs(stored.at(id).at("occurrence_probability").get<double>() - o["occurrence_probability"].get<double>()) < 1e-9,
          "Stored outcomes disagree with probability model");
    if (cards.at(id).at("rarity") == "M") mythics[id] = 0;
  }
  check(!mythics.empty(), "No Mythic cards in this booster pool");
  const double chance = 1.0 / mythics.size();
  for (auto &value : mythics) value = chance;
  Json batch_slots = Json::array();
  for (size_t i = 0; i < slots.size(); ++i) {
    slots[i]["draws"] = slots[i]["draws"].get<int64_t>() * horizon - (i == 0 ? 1 : 0);
    if (slots[i]["draws"].get<int64_t>() > 0) batch_slots.push_back(slots[i]);
  }
  batch_slots.push_back({{"draws", 1}, {"probabilities", mythics}});
  auto result = booster;
  result["outcomes"] = moments(batch_slots);
  result["verification"]["model"] = {{"type", "independent_slots"}, {"slots", batch_slots}};
  return result;
}
} // namespace pity

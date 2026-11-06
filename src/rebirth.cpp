#include "rebirth.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <vector>

namespace rebirth {
namespace {
[[noreturn]] void invalid(const std::string& message) { throw std::runtime_error(message); }
int64_t count(const Json& value, const std::string& label) {
  if (!value.is_number_integer()) invalid(label + " must be a nonnegative integer");
  if (value.is_number_unsigned() && value.get<uint64_t>() > static_cast<uint64_t>(std::numeric_limits<int64_t>::max()))
    invalid(label + " is too large");
  auto n = value.get<int64_t>();
  if (n < 0) invalid(label + " must be nonnegative");
  return n;
}
double probability(const Json& value) {
  if (!value.is_number()) invalid("Invalid rebirth slot probability");
  double p = value.get<double>();
  if (!std::isfinite(p) || p < 0 || p > 1) invalid("Invalid rebirth slot probability");
  return p;
}
std::string card_id(const Json& value) {
  return value.is_string() ? value.get<std::string>() : value.dump();
}

double capped_new_cards(const Json& booster, const std::vector<std::string>& missing,
                        int64_t deficit, double marginal_expectation, const Cards& cards) {
  if (missing.empty() || deficit == 0) return 0;
  if (static_cast<uint64_t>(deficit) >= missing.size()) return marginal_expectation;
  const auto verification = booster.value("verification", Json(nullptr));
  if (!verification.is_object() || !verification.contains("model"))
    invalid("Capped rebirth progress requires an independent-slot probability model");
  const auto& model = verification.at("model");
  if (model.value("type", "") != "independent_slots" || !model.at("slots").is_array())
    invalid("Capped rebirth progress requires an independent-slot probability model");
  const auto& slots = model.at("slots");
  int64_t draws_total = 0;
  for (const auto& slot : slots) {
    auto draws = count(slot.at("draws"), "Slot draws");
    if (draws < 1 || draws > 10000 || draws_total > 100000 - draws)
      invalid("Invalid or excessive slot draw count");
    draws_total += draws;
  }
  if (draws_total == 0) invalid("Empty rebirth slot model");
  if (deficit >= draws_total) return marginal_expectation;
  if (deficit > 10000000 / draws_total)
    invalid("Rebirth cap is too large for exact distinct-card progress evaluation");

  const size_t cap = static_cast<size_t>(deficit);
  std::vector<double> distribution(cap + 1, 0);
  distribution[0] = 1;
  for (const auto& slot : slots) {
    const auto& probabilities = slot.at("probabilities");
    if (!probabilities.is_object()) invalid("Slot probabilities must be an object");
    double sum = 0;
    for (const auto& [cid, p] : probabilities.items()) {
      if (!cards.contains(cid)) invalid("Unknown card in rebirth slot model");
      sum += probability(p);
    }
    if (std::abs(sum - 1) > 1e-8) invalid("Rebirth slot probabilities must sum to one");
    double useful = 0, first = -1;
    for (const auto& cid : missing) {
      double p = probabilities.contains(cid) ? probability(probabilities.at(cid)) : 0;
      useful += p;
      if (first < 0) first = p;
      // For cap=1, only the probability of any missing card is needed.
      if (cap > 1 && std::abs(p - first) > 1e-12)
        invalid("Capped rebirth progress requires uniform missing-card probabilities within each rarity");
    }
    useful = std::clamp(useful, 0.0, 1.0);
    if (useful == 0) continue;
    auto draws = count(slot.at("draws"), "Slot draws");
    for (int64_t draw = 0; draw < draws; ++draw) {
      std::vector<double> next(cap + 1, 0);
      next[cap] = distribution[cap];
      for (size_t k = 0; k < cap; ++k) {
        double new_probability = useful * (1 - static_cast<double>(k) / missing.size());
        next[k] += distribution[k] * (1 - new_probability);
        next[k + 1] += distribution[k] * new_probability;
      }
      distribution.swap(next);
    }
  }
  double expected = 0;
  for (size_t k = 1; k <= cap; ++k) expected += k * distribution[k];
  return std::clamp(expected, 0.0, static_cast<double>(deficit));
}
}  // namespace

State load(const Json& input, const Cards& cards, const std::set<std::string>& owned) {
  if (!input.is_object() || input.value("schema_version", 0) != 1 || input.value("counting", "") != "unique")
    invalid("Rebirth state requires schema_version=1 and counting=unique");
  State state;
  state.owned = owned;
  state.collected_at = input.at("collected_at").get<std::string>();
  state.next_rebirth = count(input.at("next_rebirth"), "Next rebirth");
  if (state.next_rebirth == 0 || state.collected_at.empty()) invalid("Missing rebirth level or capture timestamp");
  const auto& requirements = input.at("requirements");
  if (!requirements.is_object() || requirements.size() != rarities.size())
    invalid("Rebirth state must contain exactly the six rarity-count requirements");
  state.summary = Json::object();
  for (size_t i = 0; i < rarities.size(); ++i) {
    const auto& rarity = rarities[i];
    auto& requirement = state.requirements[i];
    const auto& row = requirements.at(rarity);
    requirement.current = count(row.at("current"), rarity + " current count");
    requirement.target = count(row.at("target"), rarity + " target count");
    int64_t observed = 0;
    for (const auto& cid : owned) if (cards.at(cid).at("rarity") == rarity) ++observed;
    if (observed != requirement.current)
      invalid("Rebirth holdings and current count disagree for " + rarity + "; refresh the rebirth state");
    requirement.remaining = std::max<int64_t>(0, requirement.target - requirement.current);
    if (requirement.remaining > 0) ++state.unfinished;
    state.summary[rarity] = {{"current", requirement.current}, {"target", requirement.target},
                            {"remaining", requirement.remaining}};
  }
  return state;
}

Progress evaluate(const Json& booster, const Cards& cards, const State& state) {
  Progress result;
  for (size_t i = 0; i < rarities.size(); ++i) {
    const auto& rarity = rarities[i];
    const auto deficit = state.requirements[i].remaining;
    std::vector<std::string> missing;
    double expected_new = 0;
    for (const auto& outcome : booster.at("outcomes")) {
      auto cid = card_id(outcome.at("card_id"));
      if (cards.at(cid).at("rarity") == rarity && !state.owned.contains(cid)) {
        double occurrence = probability(outcome.at("occurrence_probability"));
        if (occurrence > 0) { missing.push_back(cid); expected_new += occurrence; }
      }
    }
    double credited = deficit == 0 ? 0 : capped_new_cards(booster, missing, deficit, expected_new, cards);
    double fraction = deficit == 0 ? 0 : credited / static_cast<double>(deficit);
    result.by_rarity[rarity] = {{"expected_distinct_new_cards", expected_new},
      {"expected_credited_cards", credited}, {"expected_fraction_of_remaining_gap", fraction}};
    result.score += fraction;
  }
  if (state.unfinished > 0) result.score /= state.unfinished;
  return result;
}
}  // namespace rebirth

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>
#include "ortools/sat/cp_model.h"
#include "ortools/sat/cp_model_solver.h"
#include "rebirth.h"

using json = nlohmann::json;
namespace sat = operations_research::sat;
namespace fs = std::filesystem;
constexpr int64_t SCALE = 1000000;

struct Options {
  std::string dataset = "data/latest.json", owned, window = "7d", format = "text";
  std::string command, action, card_id, mode = "paid";
  std::string rebirth_state;
  std::vector<std::string> universes;
  double weight = 1, fee = 0;
};

[[noreturn]] void fail(const std::string& message) { throw std::runtime_error(message); }

json read_json(const std::string& path) {
  std::ifstream stream(path);
  if (!stream) fail("Cannot read " + path);
  json value;
  stream >> value;
  return value;
}

std::string id(const json& value) {
  if (value.is_string() && !value.get<std::string>().empty()) return value.get<std::string>();
  if (value.is_number_integer()) return value.dump();
  fail("IDs must be nonempty strings or integers");
}

double finite_number(const json& value, const std::string& label, double lower = 0,
                     double upper = std::numeric_limits<double>::max()) {
  if (!value.is_number()) fail(label + " must be numeric");
  double number = value.get<double>();
  if (!std::isfinite(number) || number < lower || number > upper) fail(label + " is out of range");
  return number;
}

std::string fold(std::string value) {
  // Preserve UTF-8; catalogue names can always be supplied verbatim.
  for (char& c : value) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
  return value;
}

void help() {
  std::cout << R"(Kyara solver 0.1.0 (C++ / OR-Tools CP-SAT)
Usage: solve [options]
       solve universes [--dataset PATH]
       solve owned add|remove|list --owned PATH [--card-id ID] [--dataset PATH]

  --dataset PATH           Snapshot JSON (default data/latest.json)
  --universe NAME          Select a universe; repeat to select several
  --owned PATH             Owned card IDs JSON (omitted: empty collection)
  --rebirth-state PATH     Optimize rarity-count progress using captured rebirth state
  --profit-weight NUMBER   0=progress, 1=profit, 0.5=equal normalized weight
  --median-window 7d|30d   Default 7d; no missing-price substitution
  --fee NUMBER             Proportional sale fee in [0,1] (default 0)
  --purchase-mode paid|free  Chakra purchase or free-pack token (default paid)
  --format text|json       Output format (default text)
  --version                Print application version

Free mode includes boosters accepting free packs and zero-cost boosters.
It treats their opening cost as zero. Paid mode includes positive-cost boosters.
Weight below 1 requires --universe or --rebirth-state.
Rebirth mode defaults to weight 0 and reads holdings/targets from its state file.
It cannot be combined with --universe or --owned. Only rarity criteria are scored.
)";
}

Options parse(int argc, char** argv) {
  Options options;
  bool explicit_weight = false;
  int index = 1;
  if (index < argc && std::string(argv[index]) == "universes") { options.command = argv[index++]; }
  else if (index < argc && std::string(argv[index]) == "owned") {
    options.command = argv[index++];
    if (index >= argc) fail("owned requires add, remove, or list");
    options.action = argv[index++];
  }
  while (index < argc) {
    std::string key = argv[index++];
    if (key == "--help" || key == "-h") { help(); std::exit(0); }
    if (key == "--version") { std::cout << "kyara-solver 0.1.0\n"; std::exit(0); }
    if (index >= argc) fail("Missing value for " + key);
    std::string value = argv[index++];
    if (key == "--dataset") options.dataset = value;
    else if (key == "--owned") options.owned = value;
    else if (key == "--rebirth-state") options.rebirth_state = value;
    else if (key == "--card-id") options.card_id = value;
    else if (key == "--universe") options.universes.push_back(value);
    else if (key == "--median-window") options.window = value;
    else if (key == "--format") options.format = value;
    else if (key == "--purchase-mode") options.mode = value;
    else if (key == "--profit-weight" || key == "--fee") {
      size_t consumed = 0;
      double number = std::stod(value, &consumed);
      if (consumed != value.size() || !std::isfinite(number) || number < 0 || number > 1)
        fail(key + " must be a finite number in [0,1]");
      if (key == "--fee") options.fee = number;
      else { options.weight = number; explicit_weight = true; }
    } else fail("Unknown option " + key);
  }
  if (options.window != "7d" && options.window != "30d") fail("--median-window must be 7d or 30d");
  if (options.format != "text" && options.format != "json") fail("--format must be text or json");
  if (options.mode != "paid" && options.mode != "free") fail("--purchase-mode must be paid or free");
  if (!options.rebirth_state.empty()) {
    if (!options.command.empty() || !options.universes.empty() || !options.owned.empty())
      fail("--rebirth-state cannot be combined with subcommands, --universe, or --owned");
    if (!explicit_weight) options.weight = 0;
  }
  if (options.command.empty() && options.weight < 1 && options.universes.empty() && options.rebirth_state.empty())
    fail("Progress weight requires --universe or --rebirth-state");
  return options;
}

std::set<std::string> owned_cards(const std::string& path, const std::map<std::string, json>& cards,
                                  bool allow_new = false) {
  if (path.empty()) return {};
  if (allow_new && !fs::exists(path)) return {};
  json data = read_json(path);
  if (!data.is_object() || data.value("schema_version", 0) != 1 || !data.at("owned").is_array())
    fail("Ownership file requires schema_version=1 and an owned array");
  std::set<std::string> result;
  for (const auto& value : data.at("owned")) {
    auto key = id(value);
    if (!cards.contains(key)) fail("Unknown owned card ID " + key);
    if (!result.insert(key).second) fail("Duplicate owned card ID " + key);
  }
  return result;
}

void ownership(const Options& options, const std::map<std::string, json>& cards) {
  if (options.owned.empty()) fail("owned requires --owned PATH");
  auto owned = owned_cards(options.owned, cards, options.action == "add");
  if (options.action == "list") {
    std::cout << json{{"schema_version", 1}, {"owned", owned}}.dump(2) << '\n';
    return;
  }
  if (options.action != "add" && options.action != "remove") fail("owned action must be add, remove, or list");
  if (!cards.contains(options.card_id)) fail("Provide a known --card-id");
  if (options.action == "add") owned.insert(options.card_id); else owned.erase(options.card_id);
  fs::path target(options.owned);
  if (!target.parent_path().empty()) fs::create_directories(target.parent_path());
  fs::path temporary = target;
  temporary += ".tmp";
  {
    std::ofstream stream(temporary);
    if (!stream) fail("Cannot write ownership file");
    stream << json{{"schema_version", 1}, {"owned", owned}}.dump(2) << '\n';
    stream.close();
    if (!stream) fail("Writing ownership file failed");
  }
  fs::rename(temporary, target);
  std::cout << "Saved " << owned.size() << " owned IDs to " << options.owned << '\n';
}

struct Candidate {
  std::string id, name;
  double cost = 0, proceeds = 0, profit = 0, progress = 0;
  double normalized_profit = 0, normalized_progress = 0;
  int64_t score = 0;
  size_t priced = 0, total = 0;
  bool profit_known = true;
  json opening_context = nullptr;
  rebirth::Progress rebirth_progress;
};

json run(const Options& options, const json& data, const std::map<std::string, json>& cards) {
  auto owned = owned_cards(options.rebirth_state.empty() ? options.owned : options.rebirth_state, cards);
  std::optional<rebirth::State> rebirth_state;
  if (!options.rebirth_state.empty()) rebirth_state = rebirth::load(read_json(options.rebirth_state), cards, owned);
  std::map<std::string, std::set<std::string>> universe_names;
  std::set<std::string> exact_universe_names;
  for (const auto& [key, card] : cards) {
    (void)key;
    const auto name = card.at("universe").get<std::string>();
    universe_names[fold(name)].insert(name);
    exact_universe_names.insert(name);
  }
  std::set<std::string> selected;
  for (const auto& name : options.universes) {
    if (exact_universe_names.contains(name)) {
      selected.insert(name);
    } else {
      if (!universe_names.contains(fold(name))) fail("Unknown universe '" + name + "'; use solve universes");
      const auto& matches = universe_names.at(fold(name));
      if (matches.size() != 1) fail("Ambiguous universe '" + name + "'; use an exact spelling from solve universes");
      selected.insert(*matches.begin());
    }
  }
  std::set<std::string> targets;
  for (const auto& [key, card] : cards)
    if (selected.contains(card.at("universe").get<std::string>()) && !owned.contains(key)) targets.insert(key);

  std::vector<Candidate> candidates;
  json excluded = json::array();
  std::set<std::string> booster_ids;
  for (const auto& booster : data.at("boosters")) {
    Candidate c;
    c.id = id(booster.at("id"));
    if (!booster_ids.insert(c.id).second) fail("Duplicate booster ID " + c.id);
    c.name = booster.at("name").get<std::string>();
    if (booster.contains("verification") && booster["verification"].is_object())
      c.opening_context = booster["verification"].value("opening_context", json(nullptr));
    json reasons = booster.at("issues");
    if (!reasons.is_array()) fail("Booster issues must be an array");
    if (!booster.at("available").get<bool>()) reasons.push_back("unavailable at snapshot time");
    if (booster.at("cost").is_null()) reasons.push_back("missing cost");
    else c.cost = finite_number(booster.at("cost"), "booster cost");
    if (options.mode == "paid" && c.cost == 0) reasons.push_back("not a paid booster");
    if (options.mode == "free") {
      if (c.cost != 0 && !booster.value("uses_free_packs", false)) reasons.push_back("does not accept free packs");
      c.cost = 0;
    }
    c.total = booster.at("outcomes").size();
    if (c.total == 0) reasons.push_back("missing card outcomes");
    std::set<std::string> seen;
    for (const auto& outcome : booster.at("outcomes")) {
      auto cid = id(outcome.at("card_id"));
      if (!cards.contains(cid) || !seen.insert(cid).second) fail("Unknown or duplicate outcome card " + cid);
      double expected = finite_number(outcome.at("expected_copies"), "expected copies");
      double probability = finite_number(outcome.at("occurrence_probability"), "occurrence probability", 0, 1);
      if (probability > expected + 1e-12 || ((expected > 0) != (probability > 0))) fail("Inconsistent card moments");
      if (targets.contains(cid)) c.progress += probability;
      auto price = cards.at(cid).at("median" + options.window);
      if (price.is_null()) {
        c.profit_known = false;
        if (options.weight > 0) reasons.push_back("missing " + options.window + " median for card " + cid);
      } else {
        ++c.priced;
        c.proceeds += expected * finite_number(price, "median price") * (1 - options.fee);
      }
    }
    if (rebirth_state && options.weight < 1 && reasons.empty()) {
      try {
        c.rebirth_progress = rebirth::evaluate(booster, cards, *rebirth_state);
        c.progress = c.rebirth_progress.score;
      } catch (const std::exception& error) {
        reasons.push_back(std::string("rebirth progress: ") + error.what());
      }
    }
    c.profit = c.proceeds - c.cost;
    if (!std::isfinite(c.profit) || !std::isfinite(c.progress)) fail("Objective overflow");
    if (!reasons.empty()) excluded.push_back({{"id", c.id}, {"name", c.name}, {"reasons", reasons}});
    else candidates.push_back(c);
  }
  std::sort(candidates.begin(), candidates.end(), [](const auto& a, const auto& b) { return a.id < b.id; });
  json result = {
    {"schema_version", 1}, {"application_version", "0.1.0"}, {"solver", "OR-Tools CP-SAT"},
    {"ortools_version", KYARA_ORTOOLS_VERSION},
    {"snapshot_id", data.at("snapshot_id")}, {"collected_at", data.at("collected_at")},
    {"synthetic", data.value("synthetic", false)}, {"purchase_mode", options.mode},
    {"profit_weight", options.weight}, {"fee", options.fee}, {"median_window", options.window},
    {"progress_objective", rebirth_state ? "rebirth" : "collection"},
    {"universes", selected}, {"owned_ids", owned}, {"missing_target_cards", targets.size()},
    {"score_scale", SCALE}, {"excluded", excluded}, {"warnings", json::array()},
    {"ranking", json::array()}, {"best", nullptr}, {"status", "NO_ELIGIBLE_BOOSTER"}
  };
  if (rebirth_state) {
    result["rebirth"] = {{"next_rebirth", rebirth_state->next_rebirth},
      {"collected_at", rebirth_state->collected_at}, {"requirements", rebirth_state->summary},
      {"unfinished_rarities", rebirth_state->unfinished}, {"rarity_targets_met", rebirth_state->unfinished == 0}};
    result["warnings"].push_back("Rebirth scoring considers unique-card rarity counts only; other rebirth conditions are not evaluated");
  }
  // Freshness metadata is informational and never alters scores on replay.
  if (data.contains("collected_at_unix")) {
    auto seconds = std::time(nullptr) - data.at("collected_at_unix").get<int64_t>();
    result["snapshot_age_seconds"] = seconds;
    if (seconds > 86400) result["warnings"].push_back("Snapshot is older than 24 hours; availability and prices may have changed");
  }
  if (result["synthetic"].get<bool>()) result["warnings"].push_back("Synthetic fixture: not live Kyara data");
  if (options.fee == 0) result["warnings"].push_back("Selling fee is assumed to be zero");
  if (!rebirth_state && options.weight < 1 && targets.empty()) result["warnings"].push_back("All selected cards are owned; completion contributes zero");
  if (rebirth_state && rebirth_state->unfinished == 0) {
    result["warnings"].push_back("All rarity-count targets are already met; this does not establish rebirth eligibility");
    if (options.weight == 0) { result["status"] = "REBIRTH_RARITY_TARGETS_MET"; return result; }
  }
  if (candidates.empty()) return result;
  if (candidates.size() > 1000000) fail("Too many candidates for bounded integer scoring");
  double pmin = std::numeric_limits<double>::max(), pmax = -pmin, umin = pmin, umax = -pmin;
  for (const auto& c : candidates) {
    if (c.profit_known) { pmin = std::min(pmin, c.profit); pmax = std::max(pmax, c.profit); }
    umin = std::min(umin, c.progress); umax = std::max(umax, c.progress);
  }
  for (auto& c : candidates) {
    if (options.weight > 0 && pmax > pmin) c.normalized_profit = (c.profit - pmin) / (pmax - pmin);
    if (options.weight < 1 && umax > umin) c.normalized_progress = (c.progress - umin) / (umax - umin);
    const double weighted = options.weight * c.normalized_profit + (1 - options.weight) * c.normalized_progress;
    c.score = std::llround(weighted * SCALE);
    if (c.score < 0 || c.score > SCALE) fail("Invalid normalized score");
  }
  sat::CpModelBuilder model;
  std::vector<sat::BoolVar> variables;
  sat::LinearExpr objective;
  for (size_t i = 0; i < candidates.size(); ++i) {
    auto choice = model.NewBoolVar().WithName(candidates[i].id);
    variables.push_back(choice);
    // The multiplier makes ID tie-breaking strictly subordinate to a score unit.
    int64_t coefficient = candidates[i].score * (static_cast<int64_t>(candidates.size()) + 1)
                          + static_cast<int64_t>(candidates.size() - i);
    objective += coefficient * choice;
  }
  model.AddExactlyOne(variables);
  model.Maximize(objective);
  sat::SatParameters parameters;
  parameters.set_num_search_workers(1);
  parameters.set_random_seed(0);
  const auto response = sat::SolveWithParameters(model.Build(), parameters);
  if (response.status() != sat::CpSolverStatus::OPTIMAL) fail("CP-SAT did not prove optimality");
  std::string winner;
  for (size_t i = 0; i < variables.size(); ++i)
    if (sat::SolutionBooleanValue(response, variables[i])) winner = candidates[i].id;
  std::sort(candidates.begin(), candidates.end(), [](const auto& a, const auto& b) {
    return a.score != b.score ? a.score > b.score : a.id < b.id;
  });
  if (winner != candidates.front().id) fail("CP-SAT result disagrees with score ranking");
  result["status"] = "OPTIMAL";
  for (const auto& c : candidates) {
    result["ranking"].push_back({
      {"id", c.id}, {"name", c.name}, {"cost", c.cost},
      {"opening_context", c.opening_context},
      {"expected_proceeds", c.profit_known ? json(c.proceeds) : json(nullptr)},
      {"expected_profit", c.profit_known ? json(c.profit) : json(nullptr)},
      {"roi", c.profit_known && c.cost > 0 ? json(c.profit / c.cost) : json(nullptr)},
      {"expected_distinct_new_cards", rebirth_state ? json(nullptr) : json(c.progress)}, {"normalized_profit", c.normalized_profit},
      {"normalized_completion", rebirth_state ? json(nullptr) : json(c.normalized_progress)}, {"score", c.score},
      {"price_coverage", {{"known", c.priced}, {"total", c.total}}}
    });
    if (rebirth_state) {
      result["ranking"].back()["rebirth_progress"] = options.weight < 1 ? json(c.rebirth_progress.score) : json(nullptr);
      result["ranking"].back()["normalized_rebirth_progress"] = c.normalized_progress;
      result["ranking"].back()["rebirth_by_rarity"] = options.weight < 1 ? c.rebirth_progress.by_rarity : json(nullptr);
    }
  }
  result["best"] = result["ranking"][0];
  if (result["best"]["opening_context"].is_object())
    result["warnings"].push_back(result["best"]["opening_context"].value("description", "Results are conditional on the recorded opening context"));
  size_t ties = std::count_if(candidates.begin(), candidates.end(), [&](const auto& c) { return c.score == candidates[0].score; });
  result["best_score_tie_count"] = ties;
  const bool no_paid_purchase = options.mode == "paid" && options.weight == 1 && pmax < 0;
  result["recommend_paid_purchase"] = options.mode == "paid" ? json(!no_paid_purchase) : json(nullptr);
  if (no_paid_purchase) result["warnings"].push_back("All evaluated paid boosters have negative expected profit; no paid purchase recommended");
  return result;
}

int main(int argc, char** argv) {
  try {
    auto options = parse(argc, argv);
    auto data = read_json(options.dataset);
    if (!data.is_object() || data.value("schema_version", 0) != 1) fail("Unsupported dataset schema");
    if (!data.at("cards").is_array() || !data.at("boosters").is_array()) fail("Dataset cards and boosters must be arrays");
    std::map<std::string, json> cards;
    for (const auto& card : data.at("cards")) {
      auto key = id(card.at("id"));
      if (!cards.emplace(key, card).second) fail("Duplicate card ID " + key);
    }
    if (options.command == "owned") { ownership(options, cards); return 0; }
    if (options.command == "universes") {
      std::set<std::string> names;
      for (const auto& [key, card] : cards) { (void)key; names.insert(card.at("universe").get<std::string>()); }
      for (const auto& name : names) std::cout << name << '\n';
      return 0;
    }
    auto result = run(options, data, cards);
    if (options.format == "json") std::cout << result.dump(2) << '\n';
    else {
      std::cout << "Snapshot " << result["snapshot_id"].get<std::string>() << " (" << result["collected_at"].get<std::string>() << ")\n";
      std::cout << "Mode: " << options.mode << "; profit weight: " << options.weight << "; fee: " << options.fee << '\n';
      if (result.contains("rebirth")) {
        std::cout << "Next rebirth: " << result["rebirth"]["next_rebirth"] << " (state "
                  << result["rebirth"]["collected_at"].get<std::string>() << ")\n";
        for (const auto& [rarity, requirement] : result["rebirth"]["requirements"].items())
          std::cout << rarity << ": " << requirement["current"] << '/' << requirement["target"]
                    << " (" << requirement["remaining"] << " missing)\n";
      }
      if (result.contains("snapshot_age_seconds")) std::cout << "Snapshot age: " << result["snapshot_age_seconds"] << " seconds\n";
      for (const auto& warning : result["warnings"]) std::cout << "Note: " << warning.get<std::string>() << '\n';
      if (result["status"] == "REBIRTH_RARITY_TARGETS_MET") std::cout << "Rarity-count targets already met.\n";
      else if (result["best"].is_null()) std::cout << "No eligible booster.\n";
      else std::cout << "Best booster: " << result["best"]["name"].get<std::string>() << '\n';
      for (const auto& row : result["ranking"]) {
        std::cout << row["id"].get<std::string>() << " | " << row["name"].get<std::string>()
                  << " | profit " << row["expected_profit"];
        if (row.contains("rebirth_progress"))
          std::cout << " | rebirth progress " << row["rebirth_progress"];
        else std::cout << " | new cards " << row["expected_distinct_new_cards"];
        std::cout << " | score " << row["score"] << " | prices " << row["price_coverage"] << '\n';
      }
      for (const auto& row : result["excluded"])
        std::cout << "Excluded " << row["id"].get<std::string>() << ": " << row["reasons"] << '\n';
    }
    return result["best"].is_null() && result["status"] != "REBIRTH_RARITY_TARGETS_MET" ? 3 : 0;
  } catch (const std::exception& exc) {
    std::cerr << "solve: " << exc.what() << '\n';
    return 2;
  }
}

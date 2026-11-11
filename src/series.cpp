#include "series.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iostream>
#include <map>
#include <nlohmann/json.hpp>
#include <regex>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace series {
namespace {
using Json = nlohmann::json;
void check(bool condition, const std::string &message) {
  if (!condition)
    throw std::runtime_error(message);
}
std::string id(const Json &value) {
  if (value.is_string() && !value.get<std::string>().empty())
    return value.get<std::string>();
  if (value.is_number_integer() && value.get<double>() >= 0 && value.get<double>() <= 9007199254740991.0)
    return value.dump();
  throw std::runtime_error("Invalid card ID");
}
double price(const Json &value) {
  check(value.is_number(), "Price must be numeric");
  const double n = value.get<double>();
  check(std::isfinite(n) && n >= 0, "Invalid price or total cost");
  return n;
}
std::set<std::string> names(const Json &values) {
  check(values.is_array(), "Series names must be an array");
  std::set<std::string> result;
  for (const auto &value : values) {
    check(value.is_string() && value.get<std::string>().find_first_not_of(" \t\r\n") != std::string::npos,
          "Invalid series name");
    check(result.insert(value.get<std::string>()).second, "Duplicate series name");
  }
  return result;
}
int64_t capture(const Json &value) {
  check(value.is_string(), "Missing capture time");
  const auto text = value.get<std::string>();
  static const std::regex pattern(R"(^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$)");
  std::smatch m;
  check(std::regex_match(text, m, pattern), "Invalid capture time");
  using namespace std::chrono;
  const year_month_day date{year{std::stoi(m[1])}, month{static_cast<unsigned>(std::stoi(m[2]))}, day{static_cast<unsigned>(std::stoi(m[3]))}};
  const int h = std::stoi(m[4]), min = std::stoi(m[5]), sec = std::stoi(m[6]);
  check(date.ok() && h < 24 && min < 60 && sec < 60, "Invalid capture time");
  int64_t result = sys_days{date}.time_since_epoch().count() * 86400 + h * 3600 + min * 60 + sec;
  const std::string zone = m[7];
  if (zone != "Z") {
    const int zh = std::stoi(zone.substr(1, 2)), zm = std::stoi(zone.substr(4, 2));
    check(zh < 24 && zm < 60, "Invalid capture timezone");
    result -= (zone[0] == '+' ? 1 : -1) * (zh * 3600 + zm * 60);
  }
  return result;
}

Json solve(const Json &input, const std::string &window) {
  check(window == "7d" || window == "30d", "Median window must be 7d or 30d");
  check(input.is_object() && input.at("schema_version") == 1, "Unsupported series schema");
  const auto captured = capture(input.at("collected_at"));
  check(input.at("cards").is_array() && input.at("owned").is_array(), "Invalid cards or holdings");
  const auto completed = names(input.at("completed_series"));
  const auto remaining = names(input.at("remaining_series"));
  std::set<std::string> ids, owned, expected;
  std::map<std::string, std::vector<Json>> groups;
  for (auto card : input["cards"]) {
    const auto cid = id(card.at("id"));
    check(ids.insert(cid).second, "Duplicate series card ID");
    check(card.at("name").is_string() && card.at("universe").is_string(), "Invalid card name/universe");
    const auto universe = card["universe"].get<std::string>();
    check(universe.find_first_not_of(" \t\r\n") != std::string::npos, "Invalid universe");
    for (const auto *field : {"median7d", "median30d"})
      if (!card.at(field).is_null()) price(card[field]);
    card["id"] = cid;
    groups[universe].push_back(std::move(card));
  }
  for (const auto &value : input["owned"]) {
    const auto cid = id(value);
    check(ids.contains(cid) && owned.insert(cid).second, "Unknown or duplicate owned card");
  }
  for (const auto &[universe, cards] : groups)
    if (cards.size() >= 5 && !completed.contains(universe)) expected.insert(universe);
  check(remaining == expected, "Remaining series do not match catalogue and missions");
  Json result = {{"status", "NO_ELIGIBLE_SERIES"}, {"solver", "exact enumeration"},
                 {"collected_at", input["collected_at"]}, {"window", window},
                 {"ranking", Json::array()}, {"best", nullptr}, {"excluded", Json::array()},
                 {"warnings", {"Historical medians estimate purchase costs; current listings, availability and future prices may differ.",
                               "Purchase order does not change the estimated total. Missing cards are listed cheapest first; ties use card ID."}}};
  if (input.value("synthetic", false)) result["warnings"].push_back("Synthetic fixture: not live Kyara data.");
  const auto now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  if (now - captured > 86400) result["warnings"].push_back("Series snapshot is older than 24 hours; sync missions, holdings and prices again.");
  const auto field = "median" + window;
  for (const auto &[universe, cards] : groups) {
    Json reasons = Json::array(), purchases = Json::array();
    std::vector<std::string> unknown;
    if (cards.size() < 5) reasons.push_back("Fewer than 5 characters");
    if (completed.contains(universe)) reasons.push_back("Already completed in missions");
    for (const auto &card : cards) {
      if (owned.contains(card["id"].get<std::string>())) continue;
      if (card[field].is_null()) unknown.push_back(card["id"].get<std::string>());
      else purchases.push_back({{"id", card["id"]}, {"name", card["name"]}, {"price", card[field]}});
    }
    if (!unknown.empty()) {
      std::sort(unknown.begin(), unknown.end());
      std::string message = "Missing " + window + " prices for cards: ";
      for (size_t i = 0; i < unknown.size(); ++i) message += (i ? ", " : "") + unknown[i];
      reasons.push_back(message);
    }
    if (!reasons.empty()) { result["excluded"].push_back({{"universe", universe}, {"reasons", reasons}}); continue; }
    std::sort(purchases.begin(), purchases.end(), [](const auto &a, const auto &b) {
      if (a.at("price") != b.at("price")) return a.at("price") < b.at("price");
      return a.at("id") < b.at("id");
    });
    double total = 0;
    for (const auto &card : purchases) total += card["price"].template get<double>();
    price(total);
    result["ranking"].push_back({{"universe", universe}, {"total_cards", cards.size()},
                                {"owned_cards", cards.size() - purchases.size()}, {"total_cost", total}, {"missing_cards", purchases}});
  }
  auto &ranking = result["ranking"];
  std::sort(ranking.begin(), ranking.end(), [](const auto &a, const auto &b) {
    if (a.at("total_cost") != b.at("total_cost")) return a.at("total_cost") < b.at("total_cost");
    return a.at("universe") < b.at("universe");
  });
  if (!ranking.empty()) {
    result["best"] = ranking.front();
    result["status"] = ranking.front()["missing_cards"].empty() ? "SERIES_READY" : "OPTIMAL";
  }
  return result;
}
} // namespace

int cli(int argc, char **argv) {
  std::string path = "data/series.json", window = "7d", format = "text";
  for (int i = 0; i < argc; ++i) {
    const std::string key = argv[i];
    if (key == "--help" || key == "-h") {
      std::cout << "Usage: solve series [--series-state PATH] [--median-window 7d|30d] [--format text|json]\n";
      return 0;
    }
    check(++i < argc, "Missing value for " + key);
    if (key == "--series-state") path = argv[i];
    else if (key == "--median-window") window = argv[i];
    else if (key == "--format") format = argv[i];
    else throw std::runtime_error("Unknown series option " + key);
  }
  check(format == "text" || format == "json", "Format must be text or json");
  std::ifstream file(path);
  check(bool(file), "Cannot read " + path);
  Json input; file >> input;
  const auto result = solve(input, window);
  if (format == "json") std::cout << result.dump(2) << '\n';
  else {
    std::cout << "Series snapshot " << result["collected_at"] << "; " << window << " medians\n";
    if (result["best"].is_null()) std::cout << "No eligible series with complete prices.\n";
    else if (result["status"] == "SERIES_READY") std::cout << "No purchase needed: " << result["best"]["universe"] << " is ready; check Missions.\n";
    else std::cout << "Cheapest new series: " << result["best"]["universe"] << "; estimated cost " << result["best"]["total_cost"] << '\n';
    for (const auto &row : result["ranking"]) {
      std::cout << row["universe"] << " | cost " << row["total_cost"] << " | owned " << row["owned_cards"] << '/' << row["total_cards"] << '\n';
      for (const auto &card : row["missing_cards"]) std::cout << "  " << card["id"] << " | " << card["name"] << " | " << card["price"] << '\n';
    }
    for (const auto &row : result["excluded"]) std::cout << "Excluded " << row["universe"] << ": " << row["reasons"] << '\n';
    for (const auto &warning : result["warnings"]) std::cout << "Note: " << warning.get<std::string>() << '\n';
  }
  return 0;
}
} // namespace series

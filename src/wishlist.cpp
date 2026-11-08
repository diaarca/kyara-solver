#include "wishlist.h"
#include "choice.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iostream>
#include <limits>
#include <regex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace wishlist {
namespace {
using Json = nlohmann::json;
constexpr int64_t DAY = 86400000;
[[noreturn]] void invalid(const std::string &text) { throw std::runtime_error(text); }
void check(bool ok, const std::string &text) {
  if (!ok)
    invalid(text);
}
double nonnegative(const Json &v, const std::string &label) {
  check(v.is_number(), "Invalid " + label);
  double n = v.get<double>();
  check(std::isfinite(n) && n >= 0, "Invalid " + label);
  return n;
}
int64_t sales(const Json &v) {
  double n = nonnegative(v, "sale count");
  check(std::floor(n) == n && n <= 9007199254740991.0, "Invalid sale count");
  return v.get<int64_t>();
}
int64_t day(const std::string &value) {
  static const std::regex pattern(R"(^[0-9]{4}-[0-9]{2}-[0-9]{2}$)");
  check(std::regex_match(value, pattern), "Invalid daily date");
  using namespace std::chrono;
  year_month_day date{year{std::stoi(value.substr(0, 4))},
                      month{static_cast<unsigned>(std::stoi(value.substr(5, 2)))},
                      std::chrono::day{static_cast<unsigned>(std::stoi(value.substr(8, 2)))}};
  check(date.ok(), "Invalid daily date");
  return sys_days{date}.time_since_epoch().count() * DAY;
}
int64_t capture(const std::string &value) {
  static const std::regex pattern(
      R"(^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(Z|[+-][0-9]{2}:[0-9]{2})$)");
  std::smatch m;
  check(std::regex_match(value, m, pattern), "Capture time requires an ISO timestamp and timezone");
  int h = std::stoi(m[2]), minute = std::stoi(m[3]), second = std::stoi(m[4]);
  check(h < 24 && minute < 60 && second < 60, "Invalid capture time");
  std::string fraction = m[5];
  fraction.resize(3, '0');
  int64_t ms = day(m[1]) + ((h * 60 + minute) * 60 + second) * 1000LL + std::stoi(fraction);
  std::string zone = m[6];
  if (zone != "Z") {
    int zh = std::stoi(zone.substr(1, 2)), zm = std::stoi(zone.substr(4, 2));
    check(zh < 24 && zm < 60, "Invalid capture timezone");
    ms -= (zone[0] == '+' ? 1 : -1) * (zh * 60 + zm) * 60000LL;
  }
  return ms;
}
std::string date_string(int64_t ms) {
  using namespace std::chrono;
  year_month_day date{sys_days{days{ms / DAY}}};
  std::ostringstream out;
  out.width(4);
  out.fill('0');
  out << int(date.year()) << '-';
  out.width(2);
  out.fill('0');
  out << unsigned(date.month()) << '-';
  out.width(2);
  out << unsigned(date.day());
  return out.str();
}
std::string id(const Json &value) {
  std::string result;
  if (value.is_string())
    result = value.get<std::string>();
  else if (value.is_number()) {
    double n = nonnegative(value, "card ID");
    check(std::floor(n) == n && n <= 9007199254740991.0, "Invalid wishlist ID");
    result = std::to_string(static_cast<int64_t>(n));
  }
  check(!result.empty() && result.find_first_not_of("0123456789") == std::string::npos,
        "Invalid wishlist ID");
  return result;
}
} // namespace

Json solve(const Json &input, int lookback_days, const std::string &metric) {
  check((lookback_days == 1 || lookback_days == 7 || lookback_days == 30) &&
            (metric == "absolute" || metric == "percent"),
        "Invalid wishlist options");
  check(input.is_object() && input.value("schema_version", 0) == 1 && input.at("cards").is_array(),
        "Unsupported wishlist snapshot");
  auto collected = input.at("collected_at").get<std::string>();
  int64_t captured = capture(collected);
  int64_t end = static_cast<int64_t>(std::floor(static_cast<double>(captured) / DAY)) * DAY - DAY,
          start = end - lookback_days * DAY;
  Json result = {
      {"status", "NO_ELIGIBLE_CARD"},
      {"solver", "OR-Tools CP-SAT"},
      {"collected_at", collected},
      {"metric", metric},
      {"lookback_days", lookback_days},
      {"window_start", date_string(start)},
      {"window_end", date_string(end)},
      {"ranking", Json::array()},
      {"best", nullptr},
      {"excluded", Json::array()},
      {"warnings", Json::array({"Observed daily-median increases are not a forecast of "
                                "future prices or a guaranteed purchase price.",
                                "Only completed UTC days with sales are compared; sparse "
                                "history may cover less than the selected window."})}};
  if (input.value("synthetic", false))
    result["warnings"].push_back("Synthetic fixture: not live Kyara data.");
  if (std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch())
              .count() -
          captured >
      DAY)
    result["warnings"].push_back("Wishlist snapshot is older than 24 hours.");
  std::set<std::string> ids;
  for (const auto &card : input["cards"]) {
    auto cid = id(card.at("id"));
    check(ids.insert(cid).second, "Duplicate wishlist ID");
    auto name = card.at("name").get<std::string>(),
         universe = card.at("universe").get<std::string>();
    auto card_time = card.at("collected_at").get<std::string>();
    check(capture(card_time) <= captured, "Card captured after snapshot");
    check(card.at("days").is_array(), "Invalid daily history");
    std::set<std::string> seen;
    std::vector<Json> rows;
    for (const auto &row : card["days"]) {
      auto date = row.at("day").get<std::string>();
      auto instant = day(date);
      check(seen.insert(date).second, "Duplicate daily price");
      auto n = sales(row.at("n"));
      if (!row.at("median").is_null()) {
        nonnegative(row["median"], "daily median");
        if (n > 0 && instant >= start && instant <= end)
          rows.push_back(row);
      }
    }
    if (rows.size() < 2) {
      result["excluded"].push_back({{"id", cid},
                                    {"reasons",
                                     {"Need two dated medians with sales "
                                      "within the selected window"}}});
      continue;
    }
    std::sort(rows.begin(), rows.end(),
              [](const auto &a, const auto &b) { return a.at("day") < b.at("day"); });
    const auto &first = rows.front();
    const auto &last = rows.back();
    double baseline = first["median"], latest = last["median"], increase = latest - baseline;
    Json percent = baseline > 0 ? Json(100 * increase / baseline) : Json(nullptr);
    if (metric == "percent" && percent.is_null()) {
      result["excluded"].push_back(
          {{"id", cid}, {"reasons", {"Percentage increase needs a positive baseline"}}});
      continue;
    }
    double signal = metric == "percent" ? percent.get<double>() : increase;
    check(std::isfinite(signal) && (percent.is_null() || std::isfinite(percent.get<double>())),
          "Price increase overflow");
    result["ranking"].push_back({{"id", cid},
                                 {"name", name},
                                 {"universe", universe},
                                 {"collected_at", card_time},
                                 {"start_day", first["day"]},
                                 {"end_day", last["day"]},
                                 {"elapsed_days", (day(last["day"]) - day(first["day"])) / DAY},
                                 {"start_median", baseline},
                                 {"end_median", latest},
                                 {"start_sales", first["n"]},
                                 {"end_sales", last["n"]},
                                 {"increase", increase},
                                 {"increase_percent", percent},
                                 {"signal", signal},
                                 {"score", 0},
                                 {"eligible", signal > 0}});
  }
  auto &ranking = result["ranking"];
  std::sort(ranking.begin(), ranking.end(), [](const auto &a, const auto &b) {
    return a.at("id").template get<std::string>() < b.at("id").template get<std::string>();
  });
  std::vector<size_t> rising;
  double max = 0;
  for (size_t i = 0; i < ranking.size(); i++)
    if (ranking[i]["eligible"].get<bool>()) {
      rising.push_back(i);
      max = std::max(max, ranking[i]["signal"].get<double>());
    }
  if (rising.empty()) {
    if (!ranking.empty())
      result["status"] = "NO_RISING_CARDS";
    return result;
  }
  check(rising.size() <= 1000000, "Too many wishlist cards");
  std::vector<choice::Candidate> choices;
  for (const auto index : rising) {
    auto &row = ranking[index];
    const auto score = std::llround(1000000 * (row["signal"].get<double>() / max));
    row["score"] = score;
    choices.push_back({row["id"].get<std::string>(), score});
  }
  const auto winner = choice::solve(std::move(choices));
  for (const auto index : rising)
    if (ranking[index]["id"] == winner)
      result["best"] = ranking[index];
  std::sort(ranking.begin(), ranking.end(), [](const auto &a, const auto &b) {
    bool ae = a.at("eligible"), be = b.at("eligible");
    if (ae != be)
      return ae;
    if (ae && a.at("score") != b.at("score"))
      return a.at("score") > b.at("score");
    if (!ae && a.at("signal") != b.at("signal"))
      return a.at("signal") > b.at("signal");
    return a.at("id").template get<std::string>() < b.at("id").template get<std::string>();
  });
  check(!result["best"].is_null() && result["best"]["id"] == ranking[0]["id"],
        "CP-SAT choice disagrees with ranking");
  result["status"] = "OPTIMAL";
  return result;
}

int cli(int argc, char **argv) {
  std::string path = "data/wishlist.json", metric = "percent", format = "text";
  int lookback = 7;
  for (int i = 0; i < argc; i++) {
    std::string key = argv[i];
    if (key == "--help" || key == "-h") {
      std::cout << "Usage: solve wishlist [--wishlist-state PATH] "
                   "[--lookback-days 1|7|30] [--metric absolute|percent] "
                   "[--format text|json]\n";
      return 0;
    }
    check(++i < argc, "Missing value for " + key);
    std::string value = argv[i];
    if (key == "--wishlist-state")
      path = value;
    else if (key == "--metric")
      metric = value;
    else if (key == "--format")
      format = value;
    else if (key == "--lookback-days") {
      check(value == "1" || value == "7" || value == "30", "Lookback must be 1, 7 or 30 days");
      lookback = std::stoi(value);
    } else
      invalid("Unknown wishlist option " + key);
  }
  check(format == "text" || format == "json", "Format must be text or json");
  std::ifstream file(path);
  check(bool(file), "Cannot read " + path);
  Json input;
  file >> input;
  auto result = solve(input, lookback, metric);
  if (format == "json")
    std::cout << result.dump(2) << '\n';
  else {
    std::cout << "Wishlist snapshot " << result["collected_at"].get<std::string>() << "; "
              << lookback << " days; " << metric << " increase\n";
    if (result["best"].is_null())
      std::cout << "No purchase priority: no eligible upward price signal.\n";
    else
      std::cout << "Buy priority: " << result["best"]["name"].get<std::string>() << '\n';
    for (const auto &row : result["ranking"])
      std::cout << row["id"].get<std::string>() << " | " << row["name"].get<std::string>()
                << " | increase " << row["increase"] << " | percent " << row["increase_percent"]
                << " | " << row["start_day"] << " to " << row["end_day"] << " | sales "
                << row["start_sales"] << '/' << row["end_sales"] << '\n';
    for (const auto &row : result["excluded"])
      std::cout << "Excluded " << row["id"].get<std::string>() << ": " << row["reasons"] << '\n';
    for (const auto &warning : result["warnings"])
      std::cout << "Note: " << warning.get<std::string>() << '\n';
  }
  return 0;
}
} // namespace wishlist

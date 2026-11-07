#pragma once
#include <nlohmann/json.hpp>
namespace wishlist {
nlohmann::json solve(const nlohmann::json& input, int lookback_days, const std::string& metric);
int cli(int argc, char** argv);
}

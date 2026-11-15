#pragma once
#include "rebirth.h"

namespace pity {
nlohmann::json batch(const nlohmann::json &booster, const rebirth::Cards &cards, int64_t horizon);
}

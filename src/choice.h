#pragma once

#include "ortools/sat/cp_model.h"
#include "ortools/sat/cp_model_solver.h"
#include <algorithm>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace choice {
struct Candidate {
  std::string id;
  int64_t score;
};

// Choose exactly one candidate, breaking quantized-score ties by ID.
inline std::string solve(std::vector<Candidate> candidates) {
  namespace sat = operations_research::sat;
  if (candidates.empty() || candidates.size() > 1000000)
    throw std::runtime_error("Invalid choice count");
  std::sort(candidates.begin(), candidates.end(),
            [](const auto &a, const auto &b) { return a.id < b.id; });
  sat::CpModelBuilder model;
  std::vector<sat::BoolVar> variables;
  sat::LinearExpr objective;
  const auto count = static_cast<int64_t>(candidates.size());
  for (int64_t i = 0; i < count; ++i) {
    const auto &candidate = candidates[i];
    if (candidate.score < 0 || candidate.score > 1000000 ||
        (i > 0 && candidate.id == candidates[i - 1].id))
      throw std::runtime_error("Invalid choice candidate");
    auto variable = model.NewBoolVar().WithName(candidate.id);
    variables.push_back(variable);
    objective += (candidate.score * (count + 1) + count - i) * variable;
  }
  model.AddExactlyOne(variables);
  model.Maximize(objective);
  sat::SatParameters parameters;
  parameters.set_num_search_workers(1);
  parameters.set_random_seed(0);
  const auto response = sat::SolveWithParameters(model.Build(), parameters);
  if (response.status() != sat::CpSolverStatus::OPTIMAL)
    throw std::runtime_error("CP-SAT did not prove optimality");
  for (size_t i = 0; i < variables.size(); ++i)
    if (sat::SolutionBooleanValue(response, variables[i]))
      return candidates[i].id;
  throw std::runtime_error("CP-SAT returned no choice");
}
} // namespace choice

import type { Highs } from 'highs';
import { check, compareIds } from './types';

interface Choice {
  id: string;
  score: number;
}

function orderedChoices(candidates: readonly Choice[]): Choice[] {
  check(candidates.length > 0 && candidates.length <= 1000000, 'Invalid choice count');
  const choices = [...candidates].sort((a, b) => compareIds(a.id, b.id));
  choices.forEach((candidate, index) => {
    check(
      Number.isSafeInteger(candidate.score) && candidate.score >= 0 && candidate.score <= 1000000,
      'Invalid choice score',
    );
    check(index === 0 || candidate.id !== choices[index - 1].id, 'Duplicate choice ID');
  });
  return choices;
}

export function choiceModel(
  candidates: readonly Choice[],
  prefix = 'x',
  objective = 'score',
): string {
  const choices = orderedChoices(candidates),
    count = choices.length;
  const variables = choices.map((_, index) => `${prefix}${index}`);
  const terms = choices.map(
    (candidate, index) => `${candidate.score * (count + 1) + count - index} ${variables[index]}`,
  );
  return `Maximize\n ${objective}: ${terms.join(' + ')}\nSubject To\n choose_one: ${variables.join(' + ')} = 1\nBinary\n ${variables.join(' ')}\nEnd\n`;
}

export function selectChoice(
  highs: Highs,
  candidates: readonly Choice[],
  model: string,
  prefix = 'x',
): string {
  const choices = orderedChoices(candidates);
  const solution = highs.solve(model, {
    output_flag: false,
    mip_rel_gap: 0,
    mip_abs_gap: 0,
    random_seed: 0,
    threads: 1,
  });
  check(solution.Status === 'Optimal', `HiGHS did not prove optimality: ${solution.Status}`);
  const selected = choices.filter(
    (_, index) => solution.Columns[`${prefix}${index}`]?.Primal > 0.5,
  );
  check(selected.length === 1, 'HiGHS returned an invalid choice');
  return selected[0].id;
}
